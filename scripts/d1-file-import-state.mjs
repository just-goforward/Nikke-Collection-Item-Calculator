import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";

const bindingKeys = ["accountId", "databaseId", "sqlSha256", "executionId"];
const recordKeys = ["version", "binding", "sequence", "phase", "counts", "startedAt",
  "deadlineAt", "inFlight", "operation", "outcome", "postcheck"];
const limits = { init: 1, put: 1, ingest: 1, poll: 12 };
const phases = ["prepared", "init", "upload", "ingest", "poll", "api_complete", "server_failed", "unknown"];
const outcomes = ["ready", "pending", "unknown", "api_complete", "server_failed"];
const operationKeys = ["filename", "atBookmark", "finalBookmark", "etag"];
const maximumRecordBytes = 65536;
const failure = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function keys(value, expected, optional = false) {
  if (!object(value) || Object.keys(value).some(key => !expected.includes(key)) ||
      (!optional && expected.some(key => !Object.hasOwn(value, key)))) throw failure("STORE_SCHEMA");
}

function validateBinding(binding) {
  keys(binding, bindingKeys);
  if (bindingKeys.some(key => typeof binding[key] !== "string" ||
      !binding[key].length || binding[key].length > 1024)) throw failure("STORE_BINDING");
}

function sameBinding(left, right) {
  return bindingKeys.every(key => left[key] === right[key]);
}

function validateRecord(record, binding, previous, initial = false) {
  keys(record, recordKeys);
  validateBinding(record.binding);
  keys(record.counts, Object.keys(limits));
  keys(record.operation, operationKeys, true);
  if (!sameBinding(record.binding, binding)) throw failure("STORE_BINDING");
  if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
      !phases.includes(record.phase) || !outcomes.includes(record.outcome) ||
      !["not_run", "pending"].includes(record.postcheck) ||
      !Number.isSafeInteger(record.startedAt) || record.startedAt < 0 ||
      !Number.isSafeInteger(record.deadlineAt) || record.deadlineAt <= record.startedAt ||
      record.deadlineAt - record.startedAt > 600000 ||
      (record.inFlight !== null && !Object.hasOwn(limits, record.inFlight))) throw failure("STORE_SCHEMA");
  for (const [key, ceiling] of Object.entries(limits)) {
    if (!Number.isSafeInteger(record.counts[key]) || record.counts[key] < 0 ||
        record.counts[key] > ceiling) throw failure("STORE_BUDGET");
  }
  for (const value of Object.values(record.operation)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 16384)
      throw failure("STORE_SCHEMA");
  }
  if (record.inFlight !== null &&
      (record.counts[record.inFlight] === 0 ||
       (record.phase !== "unknown" &&
        record.phase !== (record.inFlight === "put" ? "upload" : record.inFlight))))
    throw failure("STORE_TRANSITION");
  for (const terminal of ["api_complete", "server_failed"]) {
    if ((record.phase === terminal) !== (record.outcome === terminal) ||
        (record.phase === terminal && record.inFlight !== null)) throw failure("STORE_TRANSITION");
  }
  if (record.postcheck === "pending" && record.phase !== "api_complete")
    throw failure("STORE_TRANSITION");
  if (initial && (record.sequence !== 1 || record.phase !== "prepared" ||
      record.outcome !== "ready" || record.inFlight !== null || record.postcheck !== "not_run" ||
      Object.keys(record.operation).length || Object.values(record.counts).some(value => value !== 0)))
    throw failure("STORE_TRANSITION");
  if (previous) {
    if (record.sequence !== previous.sequence + 1 ||
        record.startedAt !== previous.startedAt || record.deadlineAt !== previous.deadlineAt ||
        Object.keys(limits).some(key => record.counts[key] < previous.counts[key]) ||
        ["api_complete", "server_failed"].includes(previous.phase))
      throw failure("STORE_TRANSITION");
  }
  if (Buffer.byteLength(JSON.stringify(record)) > maximumRecordBytes) throw failure("STORE_SIZE");
}

// No provider capability, target identifier, pathname or raw exception is a public summary.
export function publicStateSummary(record) {
  validateRecord(record, record.binding);
  return {
    version: 1, executionId: record.binding.executionId, sequence: record.sequence,
    phase: record.phase, counts: { ...record.counts }, outcome: record.outcome,
    postcheck: record.postcheck,
  };
}

// Fixed program: all caller data crosses stdin as JSON/base64, never as PowerShell source.
// DPAPI protects integrity and confidentiality for the current Windows user. It is not
// a trusted monotonic anchor against that same user replaying an entire old snapshot.
const helperProgram = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
Add-Type -ReferencedAssemblies 'System.dll','System.Core.dll','System.Security.dll' -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class ImportState : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SA {
    public int length; public IntPtr descriptor; public int inherit;
  }
  [StructLayout(LayoutKind.Sequential)] struct FI {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateDirectory(string name, ref SA attributes);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool MoveFileEx(string from, string to, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FI info);
  readonly SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
  string directory, state, pending;
  FileStream gate;
  byte[] observed;
  bool ownsPending;
  static void Fail(string code) { throw new InvalidOperationException(code); }
  static bool Equal(byte[] a, byte[] b) {
    return a == null ? b == null : b != null && a.SequenceEqual(b);
  }
  static byte[] Hash(byte[] bytes) { using (var sha = SHA256.Create()) return sha.ComputeHash(bytes); }
  void CheckAcl(string name, bool folder) {
    if ((File.GetAttributes(name) & FileAttributes.ReparsePoint) != 0) Fail("STORE_REPARSE");
    FileSystemSecurity acl = folder ? (FileSystemSecurity)Directory.GetAccessControl(name) : File.GetAccessControl(name);
    if (!user.Equals(acl.GetOwner(typeof(SecurityIdentifier)))) Fail("STORE_ACL");
    if (folder && !acl.AreAccessRulesProtected) Fail("STORE_ACL");
    var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
    bool full = false;
    foreach (FileSystemAccessRule rule in rules) {
      if (!user.Equals(rule.IdentityReference) || rule.AccessControlType != AccessControlType.Allow)
        Fail("STORE_ACL");
      if ((rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl)
        full = true;
    }
    if (!full) Fail("STORE_ACL");
  }
  void CheckFile(FileStream file) {
    FI info;
    if (!GetFileInformationByHandle(file.SafeFileHandle, out info) || info.links != 1 ||
        (info.attributes & (uint)FileAttributes.ReparsePoint) != 0) Fail("STORE_LINK");
  }
  byte[] Ciphertext() {
    CheckAcl(directory, true);
    if (!File.Exists(state)) {
      if (Directory.Exists(state)) Fail("STORE_PARTIAL");
      return null;
    }
    CheckAcl(state, false);
    using (var file = new FileStream(state, FileMode.Open, FileAccess.Read, FileShare.Read)) {
      CheckFile(file);
      if (file.Length < 1 || file.Length > 131072) Fail("STORE_PARTIAL");
      var bytes = new byte[(int)file.Length];
      int position = 0;
      while (position < bytes.Length) {
        int read = file.Read(bytes, position, bytes.Length - position);
        if (read == 0) Fail("STORE_PARTIAL");
        position += read;
      }
      return bytes;
    }
  }
  void Unchanged() {
    byte[] current = Ciphertext();
    if (!Equal(observed, current == null ? null : Hash(current))) Fail("STORE_DISK_CHANGED");
  }
  public void Open(string location, string mode) {
    if (mode != "create" && mode != "resume") Fail("STORE_MODE");
    directory = Path.GetFullPath(location);
    if (directory.Length < 4 || directory[1] != ':' || directory[2] != '\\' ||
        directory.IndexOf(':', 2) >= 0 || directory.IndexOfAny(new char[]{'\r','\n'}) >= 0)
      Fail("STORE_PATH");
    var drive = new DriveInfo(Path.GetPathRoot(directory));
    if (drive.DriveType != DriveType.Fixed || drive.DriveFormat != "NTFS") Fail("STORE_VOLUME");
    for (var ancestor = new DirectoryInfo(directory); ancestor != null; ancestor = ancestor.Parent) {
      if (ancestor.Exists && (ancestor.Attributes & FileAttributes.ReparsePoint) != 0)
        Fail("STORE_REPARSE");
    }
    state = Path.Combine(directory, "state.dpapi");
    pending = Path.Combine(directory, "state.pending");
    if (mode == "create") {
      var acl = new DirectorySecurity();
      acl.SetOwner(user);
      acl.SetAccessRuleProtection(true, false);
      acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
        PropagationFlags.None, AccessControlType.Allow));
      byte[] descriptor = acl.GetSecurityDescriptorBinaryForm();
      var memory = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
      try {
        var sa = new SA { length = Marshal.SizeOf(typeof(SA)), descriptor = memory.AddrOfPinnedObject(), inherit = 0 };
        if (!CreateDirectory(directory, ref sa))
          Fail(Marshal.GetLastWin32Error() == 183 ? "STORE_EXISTS" : "STORE_IO");
      } finally { memory.Free(); }
    } else if (!Directory.Exists(directory)) Fail("STORE_MISSING");
    CheckAcl(directory, true);
    string lockName = Path.Combine(directory, "session.lock");
    if (mode == "resume") CheckAcl(lockName, false);
    try {
      gate = new FileStream(lockName, mode == "create" ? FileMode.CreateNew : FileMode.Open,
        FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.WriteThrough);
    } catch (IOException) { Fail("STORE_LOCKED"); }
    CheckFile(gate);
    CheckAcl(lockName, false);
    foreach (string entry in Directory.GetFileSystemEntries(directory)) {
      string name = Path.GetFileName(entry);
      if (name != "session.lock" && name != "state.dpapi") Fail("STORE_PARTIAL");
    }
    if (mode == "resume" && !File.Exists(state)) Fail("STORE_MISSING");
  }
  public string Read(string entropyText) {
    byte[] bytes = Ciphertext();
    observed = bytes == null ? null : Hash(bytes);
    if (bytes == null) return null;
    byte[] plain;
    try {
      plain = ProtectedData.Unprotect(bytes, Convert.FromBase64String(entropyText), DataProtectionScope.CurrentUser);
    } catch (CryptographicException) { Fail("STORE_AUTH"); return null; }
    try {
      if (plain.Length > 65536) Fail("STORE_SIZE");
      return Convert.ToBase64String(plain);
    } finally { Array.Clear(plain, 0, plain.Length); }
  }
  public void Prepare(string plainText, string entropyText) {
    Unchanged();
    byte[] plain = Convert.FromBase64String(plainText);
    byte[] encrypted;
    try {
      if (plain.Length > 65536) Fail("STORE_SIZE");
      encrypted = ProtectedData.Protect(plain, Convert.FromBase64String(entropyText), DataProtectionScope.CurrentUser);
    } finally { Array.Clear(plain, 0, plain.Length); }
    using (var file = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None,
        4096, FileOptions.WriteThrough)) {
      ownsPending = true;
      CheckFile(file);
      CheckAcl(pending, false);
      file.Write(encrypted, 0, encrypted.Length);
      file.Flush(true);
    }
  }
  public void Commit() {
    Unchanged();
    if (!ownsPending) Fail("STORE_PROTOCOL");
    CheckAcl(pending, false);
    // Same-volume atomic replacement, with a flushed payload and write-through rename.
    if (!MoveFileEx(pending, state, observed == null ? 8u : 9u)) Fail("STORE_COMMIT");
    ownsPending = false;
    byte[] committed = Ciphertext();
    observed = Hash(committed);
  }
  public void Abort() {
    if (ownsPending) { File.Delete(pending); ownsPending = false; }
  }
  public void Dispose() {
    try { Abort(); } finally { if (gate != null) { gate.Dispose(); gate = null; } }
  }
}
'@
$store = New-Object ImportState
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      if ($line.Length -gt 100000) { throw 'STORE_SIZE' }
      $request = ConvertFrom-Json -InputObject $line
      $value = $null
      switch ($request.command) {
        'open' { $store.Open($request.directory, $request.mode) }
        'read' { $value = $store.Read($request.entropy) }
        'prepare' { $store.Prepare($request.payload, $request.entropy) }
        'commit' { $store.Commit() }
        'abort' { $store.Abort() }
        'close' { $store.Dispose() }
        default { throw 'STORE_PROTOCOL' }
      }
      [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ ok = $true; value = $value }))
      if ($request.command -eq 'close') { break }
    } catch {
      $code = 'STORE_IO_OR_PROTECTION'
      $exception = $_.Exception
      while ($null -ne $exception) {
        if ($exception.Message -cmatch '^STORE_[A-Z_]+$') { $code = $exception.Message }
        $exception = $exception.InnerException
      }
      [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ ok = $false; code = $code }))
      break
    }
  }
} finally { $store.Dispose() }
`;

function helperEnvironment() {
  const allowed = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE",
    "TEMP", "TMP", "TMPDIR", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"];
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.includes(key.toUpperCase())) environment[key] = value;
  }
  return environment;
}

function startHelper(testHooks) {
  const environment = helperEnvironment();
  const systemRoot = Object.entries(environment).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  if (!systemRoot || !/^[a-z]:\\/i.test(systemRoot)) throw failure("STORE_PLATFORM");
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helper = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(helperProgram, "utf16le").toString("base64")],
  { env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: helper.stdout });
  let pending, ended = false, broken = false;
  const rejectPending = error => {
    if (pending) { const reject = pending.reject; clearTimeout(pending.timer); pending = null; reject(error); }
  };
  const exited = new Promise(resolve => {
    helper.once("close", () => {
      ended = true;
      lines.close();
      rejectPending(failure("STORE_HELPER_EXIT"));
      resolve();
    });
  });
  helper.on("error", () => { broken = true; rejectPending(failure("STORE_HELPER_START")); });
  helper.stdin.on("error", () => { broken = true; rejectPending(failure("STORE_HELPER_PIPE")); });
  helper.stderr.on("data", () => { /* Never forward raw OS diagnostics or private values. */ });
  lines.on("line", line => {
    if (!pending) { broken = true; helper.kill(); return; }
    const operation = pending;
    clearTimeout(operation.timer);
    pending = null;
    try {
      if (line.length > 100000) throw failure("STORE_PROTOCOL");
      const reply = JSON.parse(line);
      if (reply.ok !== true) {
        throw failure(/^STORE_[A-Z_]+$/.test(reply.code) ? reply.code : "STORE_PROTOCOL");
      }
      operation.resolve(reply.value);
    } catch (error) {
      broken = true;
      operation.reject(error?.code?.startsWith("STORE_") ? error : failure("STORE_PROTOCOL"));
    }
  });
  try { testHooks?.onHelperStarted?.({ pid: helper.pid }); }
  catch { broken = true; helper.kill(); }
  return {
    async exchange(request) {
      if (pending || ended || broken) throw failure("STORE_HELPER_CLOSED");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          broken = true;
          rejectPending(failure("STORE_HELPER_TIMEOUT"));
          helper.kill();
        }, 20000);
        pending = { resolve, reject, timer };
        helper.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    async close() {
      if (!ended) {
        if (!broken && !pending) {
          try { await this.exchange({ command: "close" }); } catch { broken = true; }
        }
        helper.stdin.end();
      }
      const timer = setTimeout(() => helper.kill(), 20000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}

/**
 * The caller must pin all four binding strings; execution IDs are never discovered.
 * create refuses every existing directory, even empty; resume requires a valid record.
 * save resolves only after durable commit. A failed save poisons/closes the session:
 * callers MUST NOT dispatch a request after that failure. close is idempotent.
 *
 * Test-only hooks observe the child PID or throw after the encrypted staging flush,
 * before commit. They cannot replace DPAPI, ACL checks, locking or the durable writer.
 */
export async function openStateStore({ directory, binding, mode, testHooks } = {}) {
  if (process.platform !== "win32") throw failure("STORE_PLATFORM");
  if (!["create", "resume"].includes(mode)) throw failure("STORE_MODE");
  validateBinding(binding);
  if (typeof directory !== "string" || !path.win32.isAbsolute(directory) ||
      !/^[a-z]:\\/i.test(directory) || directory.includes("\0")) throw failure("STORE_PATH");
  const expected = structuredClone(binding);
  const entropy = createHash("sha256")
    .update(JSON.stringify(["d1-file-import-state", 1, ...bindingKeys.map(key => expected[key])]))
    .digest("base64");
  const helper = startHelper(testHooks);
  let current = null, closed = false, busy = false;
  async function shutdown() { closed = true; await helper.close(); }
  async function persist(record) {
    validateRecord(record, expected, current, current === null);
    const bytes = Buffer.from(JSON.stringify(record));
    try {
      await helper.exchange({ command: "prepare", entropy, payload: bytes.toString("base64") });
      try { await testHooks?.beforeCommit?.({ sequence: record.sequence }); }
      catch {
        await helper.exchange({ command: "abort" });
        throw failure("STORE_TEST_WRITE_FAILURE");
      }
      await helper.exchange({ command: "commit" });
      current = structuredClone(record);
    } finally { bytes.fill(0); }
  }
  try {
    await helper.exchange({ command: "open", directory, mode });
    const encoded = await helper.exchange({ command: "read", entropy });
    if (encoded !== null) {
      const bytes = Buffer.from(encoded, "base64");
      try { current = JSON.parse(bytes.toString("utf8")); }
      catch { throw failure("STORE_SCHEMA"); }
      finally { bytes.fill(0); }
      validateRecord(current, expected);
    }
    if (mode === "resume" && current === null) throw failure("STORE_MISSING");
  } catch (error) {
    await shutdown();
    throw error;
  }
  return {
    async load() {
      if (closed) throw failure("STORE_CLOSED");
      if (busy) throw failure("STORE_BUSY");
      return current === null ? null : structuredClone(current);
    },
    async save(record) {
      if (closed) throw failure("STORE_CLOSED");
      if (busy) throw failure("STORE_BUSY");
      busy = true;
      try { await persist(structuredClone(record)); }
      catch (error) { await shutdown(); throw error; }
      finally { busy = false; }
    },
    async close() {
      if (busy) throw failure("STORE_BUSY");
      if (!closed) await shutdown();
    },
  };
}
