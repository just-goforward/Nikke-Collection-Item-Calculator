import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStateStore, publicStateSummary } from "./d1-file-import-state.mjs";

const binding = Object.freeze({
  accountId: "a".repeat(32), databaseId: "11111111-2222-4333-8444-555555555555",
  sqlSha256: "b".repeat(64), executionId: "synthetic-operation-one",
});
const prepared = () => ({
  version: 1, binding: { ...binding }, sequence: 1, phase: "prepared",
  counts: { init: 0, put: 0, ingest: 0, poll: 0 },
  startedAt: 1800000000000, deadlineAt: 1800000600000,
  inFlight: null, operation: {}, outcome: "ready", postcheck: "not_run",
});
const pendingInit = () => ({
  ...prepared(), sequence: 2, phase: "init", counts: { init: 1, put: 0, ingest: 0, poll: 0 },
  inFlight: "init", outcome: "unknown",
});
const options = (directory, mode, extra = {}) => ({ directory, mode, binding, ...extra });
const code = expected => error => error?.code === expected;

async function powershell(program, input) {
  const executable = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT,
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const completion = once(child, "close");
  child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [exit] = await completion;
    assert.equal(exit, 0, `Synthetic fixture helper failed: ${stderr}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}

const waitForHelperExit = pid => powershell(String.raw`
$ErrorActionPreference = 'Stop'
$idValue = [int](ConvertFrom-Json ([Console]::In.ReadToEnd()))
try { $p = [Diagnostics.Process]::GetProcessById($idValue) }
catch [ArgumentException] { exit 0 }
try {
  if (!$p.WaitForExit(20000)) { throw 'SYNTHETIC_HELPER_STILL_RUNNING' }
} finally { $p.Dispose() }
`, pid);

async function worker(directory, mode) {
  const child = fork(fileURLToPath(import.meta.url), ["--store-worker"], {
    execPath: process.execPath, execArgv: process.execArgv.filter(value => value !== "--test"),
    env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = once(child, "exit");
  const request = message => {
    const response = once(child, "message");
    child.send(message);
    return response.then(([value]) => value);
  };
  const opened = await request({ action: "open", directory, mode });
  return {
    child, exited, opened, request,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        await request({ action: "close" });
      }
      await exited;
    },
  };
}

if (process.argv.includes("--store-worker")) {
  let session, helperPid;
  process.on("message", async message => {
    try {
      if (message.action === "open") {
        session = await openStateStore(options(message.directory, message.mode, {
          testHooks: { onHelperStarted: ({ pid }) => { helperPid = pid; } },
        }));
        process.send({ ok: true, record: await session.load(), helperPid });
      } else if (message.action === "save") {
        await session.save(message.record);
        process.send({ ok: true });
      } else if (message.action === "close") {
        await session?.close();
        process.send({ ok: true }, () => process.disconnect());
      }
    } catch (error) {
      process.send({ ok: false, code: error.code });
      if (!session) process.disconnect();
    }
  });
} else {
  test("Windows protected operation state: synthetic security lane", { timeout: 240000 }, async t => {
    assert.equal(process.platform, "win32", "This lane requires the approved Windows DPAPI environment");
    assert.equal(process.version, "v26.13.0", "Run with the approved pinned runtime");
    const root = await mkdtemp(path.join(tmpdir(), "d1-protected-store-"));
    console.log(JSON.stringify({ syntheticFixtureRoot: root, source: fileURLToPath(import.meta.url) }));
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    let fixtureNumber = 0;
    const directory = () => path.join(root, `operation-${++fixtureNumber}`);
    const seed = async (destination, record) => {
      const session = await openStateStore(options(destination, "create"));
      await session.save(prepared());
      if (record) await session.save(record);
      await session.close();
    };

    await t.test("new process restores exact protected state and consumed budgets; public output has no capabilities", async () => {
      const destination = directory();
      const first = await worker(destination, "create");
      try {
        assert.equal(first.opened.ok, true);
        assert.equal(first.opened.record, null);
        assert.equal((await first.request({ action: "save", record: prepared() })).ok, true);
        const record = pendingInit();
        record.operation.filename = "synthetic-private-filename";
        assert.equal((await first.request({ action: "save", record })).ok, true);
      } finally { await first.close(); }
      const second = await worker(destination, "resume");
      try {
        assert.equal(second.opened.ok, true);
        assert.deepEqual(second.opened.record, {
          ...pendingInit(), operation: { filename: "synthetic-private-filename" },
        });
        const summary = publicStateSummary(second.opened.record);
        assert.deepEqual(summary, {
          version: 1, executionId: binding.executionId, sequence: 2, phase: "init",
          counts: { init: 1, put: 0, ingest: 0, poll: 0 }, outcome: "unknown", postcheck: "not_run",
        });
        const bytes = await readFile(path.join(destination, "state.dpapi"));
        assert.equal(bytes.includes(Buffer.from("synthetic-private-filename")), false);
        assert.equal(bytes.includes(Buffer.from(binding.executionId)), false);
      } finally { await second.close(); }
    });

    await t.test("create refuses any existing operation; resume never discovers execution ID or binding", async () => {
      const destination = directory();
      await seed(destination);
      const before = await readFile(path.join(destination, "state.dpapi"));
      await assert.rejects(openStateStore(options(destination, "create")), code("STORE_EXISTS"));
      await assert.rejects(openStateStore(options(directory(), "resume")), code("STORE_MISSING"));
      for (const key of Object.keys(binding)) {
        await assert.rejects(openStateStore(options(destination, "resume", {
          binding: { ...binding, [key]: `${binding[key]}-different` },
        })), code("STORE_AUTH"));
      }
      assert.deepEqual(await readFile(path.join(destination, "state.dpapi")), before);
    });

    await t.test("DPAPI authentication rejects tampered and truncated ciphertext without overwriting it", async () => {
      for (const corruption of ["tamper", "truncate"]) {
        const destination = directory();
        await seed(destination);
        const bytes = await readFile(path.join(destination, "state.dpapi"));
        const damaged = corruption === "tamper" ? Buffer.from(bytes) : bytes.subarray(0, 7);
        if (corruption === "tamper") damaged[damaged.length - 1] ^= 1;
        await writeFile(path.join(destination, "state.dpapi"), damaged);
        await assert.rejects(openStateStore(options(destination, "resume")), code("STORE_AUTH"));
        assert.deepEqual(await readFile(path.join(destination, "state.dpapi")), damaged);
      }
    });

    await t.test("private ACL grants only current user and broadening it fails closed", async () => {
      const destination = directory();
      await seed(destination);
      const evidence = JSON.parse(await powershell(String.raw`
$ErrorActionPreference = 'Stop'
$directory = ConvertFrom-Json ([Console]::In.ReadToEnd())
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rows = @()
foreach ($name in @($directory, (Join-Path $directory 'state.dpapi'), (Join-Path $directory 'session.lock'))) {
  $acl = if ([IO.Directory]::Exists($name)) { [IO.Directory]::GetAccessControl($name) } else {
    [IO.File]::GetAccessControl($name)
  }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  $rows += @{ ownerCurrent = ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value);
    onlyCurrent = (@($rules | Where-Object { $_.IdentityReference.Value -ne $sid.Value }).Count -eq 0);
    fullControl = (@($rules | Where-Object {
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq
        [Security.AccessControl.FileSystemRights]::FullControl }).Count -gt 0) }
}
$acl = [IO.Directory]::GetAccessControl($directory, [Security.AccessControl.AccessControlSections]::Access)
$protected = $acl.AreAccessRulesProtected
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'Allow')
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($directory, $acl)
@{ protected = $protected; rows = $rows } | ConvertTo-Json -Compress -Depth 5
`, destination));
      assert.equal(evidence.protected, true);
      assert.equal(evidence.rows.length, 3);
      for (const row of evidence.rows) assert.deepEqual(row, { ownerCurrent: true, onlyCurrent: true, fullControl: true });
      await assert.rejects(openStateStore(options(destination, "resume")), code("STORE_ACL"));
    });

    await t.test("concurrent process is rejected; parent death releases the OS handle without stale-lock deletion", async () => {
      const destination = directory();
      await seed(destination, pendingInit());
      const holder = await worker(destination, "resume");
      assert.equal(holder.opened.ok, true);
      try {
        await assert.rejects(openStateStore(options(destination, "resume")), code("STORE_LOCKED"));
        holder.child.kill();
        await holder.exited;
        await waitForHelperExit(holder.opened.helperPid);
        const resumed = await openStateStore(options(destination, "resume"));
        try { assert.deepEqual(await resumed.load(), pendingInit()); }
        finally { await resumed.close(); }
      } finally {
        if (holder.child.exitCode === null && holder.child.signalCode === null) {
          holder.child.kill();
          await holder.exited;
          await waitForHelperExit(holder.opened.helperPid);
        }
      }
    });

    await t.test("pre-dispatch failure after encrypted staging flush removes staging, preserves budget, and closes lock", async () => {
      const destination = directory();
      await seed(destination);
      const before = await readFile(path.join(destination, "state.dpapi"));
      let dispatches = 0;
      const session = await openStateStore(options(destination, "resume", {
        testHooks: { beforeCommit: () => { throw new Error("synthetic write failure"); } },
      }));
      await assert.rejects((async () => {
        await session.save(pendingInit());
        dispatches++;
      })(), code("STORE_TEST_WRITE_FAILURE"));
      assert.equal(dispatches, 0);
      assert.deepEqual((await readdir(destination)).sort(), ["session.lock", "state.dpapi"]);
      assert.deepEqual(await readFile(path.join(destination, "state.dpapi")), before);
      await assert.rejects(session.load(), code("STORE_CLOSED"));
      await session.close();
      const resumed = await openStateStore(options(destination, "resume"));
      try { assert.deepEqual(await resumed.load(), prepared()); }
      finally { await resumed.close(); }
    });

    await t.test("failed first write leaves no record and cannot be mistaken for a fresh or resumable operation", async () => {
      const destination = directory();
      const session = await openStateStore(options(destination, "create", {
        testHooks: { beforeCommit: () => { throw new Error("synthetic first-write failure"); } },
      }));
      await assert.rejects(session.save(prepared()), code("STORE_TEST_WRITE_FAILURE"));
      assert.deepEqual(await readdir(destination), ["session.lock"]);
      await assert.rejects(openStateStore(options(destination, "create")), code("STORE_EXISTS"));
      await assert.rejects(openStateStore(options(destination, "resume")), code("STORE_MISSING"));
    });

    await t.test("stale sequence, budget reset, binding change, and unallowlisted credentials cannot be saved", async () => {
      const destination = directory();
      await seed(destination, pendingInit());
      const invalid = [
        { ...pendingInit(), sequence: 2 },
        { ...pendingInit(), sequence: 3, counts: { init: 0, put: 0, ingest: 0, poll: 0 }, inFlight: null },
        { ...pendingInit(), sequence: 3, binding: { ...binding, executionId: "foreign-operation" } },
        { ...pendingInit(), sequence: 3, apiToken: "synthetic-disallowed-value" },
        { ...pendingInit(), sequence: 3, operation: { authorization: "synthetic-disallowed-value" } },
        { ...pendingInit(), sequence: 3, postcheck: "verified" },
      ];
      const before = await readFile(path.join(destination, "state.dpapi"));
      for (const record of invalid) {
        const session = await openStateStore(options(destination, "resume"));
        await assert.rejects(session.save(record), error => error.code?.startsWith("STORE_"));
        await session.close();
        assert.deepEqual(await readFile(path.join(destination, "state.dpapi")), before);
      }
    });

    await t.test("presigned URL cannot enter durable state; restart preserves spent INIT without that capability", async () => {
      const destination = directory();
      await seed(destination, pendingInit());
      const session = await openStateStore(options(destination, "resume"));
      await assert.rejects(session.save({
        ...pendingInit(), sequence: 3, phase: "upload", inFlight: null, outcome: "unknown",
        operation: { filename: "synthetic-object", uploadUrl: "https://upload.invalid/new-synthetic-capability" },
      }), code("STORE_SCHEMA"));
      await session.close();
      const restarted = await worker(destination, "resume");
      try {
        assert.equal(restarted.opened.ok, true);
        assert.equal(restarted.opened.record.sequence, 2);
        assert.equal(restarted.opened.record.operation.uploadUrl, undefined);
        assert.deepEqual(restarted.opened.record.counts, { init: 1, put: 0, ingest: 0, poll: 0 });
      } finally { await restarted.close(); }
    });

    await t.test("partial staging artifacts and external state changes fail closed", async () => {
      const destination = directory();
      await seed(destination);
      await writeFile(path.join(destination, "state.pending"), Buffer.from("synthetic partial ciphertext"));
      await assert.rejects(openStateStore(options(destination, "resume")), code("STORE_PARTIAL"));
      const other = directory();
      await seed(other);
      const session = await openStateStore(options(other, "resume"));
      await writeFile(path.join(other, "state.dpapi"), Buffer.from("synthetic changed ciphertext"));
      await assert.rejects(session.save(pendingInit()), code("STORE_DISK_CHANGED"));
      await session.close();
    });
  });
}
