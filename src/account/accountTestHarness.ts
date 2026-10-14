import type {
  PrivacyAccepted,
  WorkspaceDocument,
  WorkspaceGet,
  WorkspacePut,
  WorkspacePutResult,
} from "../../personal-data/src/contracts";
import { AccountController } from "./accountController";
import type { AccountView } from "./accountState";
import type { AccountApi, ApiFailure, ApiResult } from "./api";
import type { CrossTabChannel, CrossTabMessage } from "./crossTab";
import type { TabIdentity } from "./tabIdentity";
import {
  type CalculatorInput,
  DEFAULT_CALCULATOR_INPUT,
  EMPTY_WORKSPACE_DOCUMENT,
} from "./workspaceDocument";
import { calculatorInputCodec, type WorkspaceItemCodec } from "./workspaceItem";
import {
  createMemoryWorkspaceStore,
  type DraftRecord,
  type WorkspaceStore,
} from "./workspaceStore";

/** In-memory personal-data server for controller tests (CAS, op replay, account context). */
export type FakeServer = {
  userId: string | null;
  revision: number;
  lastOpId: string | null;
  document: WorkspaceDocument;
  quota: WorkspaceGet["quota"];
  /** The next N saves commit, but their answer is lost (a network failure after the commit). */
  loseAcks: number;
  authorizationUrl: string;
  deletionStatus: PrivacyAccepted["status"];
  calls: Array<{ method: keyof AccountApi; userId?: string; body?: unknown }>;
  /** Queued one-shot results per method, returned instead of the simulated behaviour. */
  overrides: Partial<Record<keyof AccountApi, Array<ApiResult<unknown>>>>;
  /** Runs inside putWorkspace before the server answers (e.g. to edit during a save). */
  beforePut?: (() => void) | undefined;
  /** Runs once when the next workspace read arrives (e.g. the session cookie switches). */
  beforeWorkspace?: (() => void) | undefined;
  /** Holds a method's answer until the promise settles (a slow server). */
  hold?: Partial<Record<keyof AccountApi, Promise<void>>>;
};

export function createFakeServer(overrides: Partial<FakeServer> = {}): FakeServer {
  return {
    userId: "user-a",
    revision: 0,
    lastOpId: null,
    loseAcks: 0,
    document: EMPTY_WORKSPACE_DOCUMENT,
    quota: { bytes: 120, limitBytes: 1_500_000, newArchivingBlocked: false },
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    deletionStatus: "complete",
    calls: [],
    overrides: {},
    ...overrides,
  };
}

export const failure = (status: number, code: string | null = null): ApiResult<never> => ({
  ok: false,
  failure: { kind: "http", status, code } satisfies ApiFailure,
});
export const networkFailure: ApiResult<never> = { ok: false, failure: { kind: "network" } };
const unauthenticated = failure(401, "unauthenticated");

function ok<T>(value: T, status = 200): ApiResult<T> {
  return { ok: true, status, value };
}

function contextFailure(server: FakeServer, userId: string): ApiResult<never> | null {
  if (!server.userId) return unauthenticated;
  return userId === server.userId ? null : failure(409, "account_context_stale");
}

type Replays = Map<string, { revision: number; body: string }>;

/** CAS save with opId replay; `loseAcks` commits but answers with a network failure. */
function fakePut(
  server: FakeServer,
  replays: Replays,
  userId: string,
  body: WorkspacePut,
): ApiResult<WorkspacePutResult> {
  const rejected = contextFailure(server, userId);
  if (rejected) return rejected;
  const replay = replays.get(body.opId);
  if (replay) {
    return replay.body === JSON.stringify(body)
      ? ok({ status: "saved" as const, revision: replay.revision, replayed: true })
      : ok({ status: "op_id_conflict" as const }, 409);
  }
  if (body.baseRevision !== server.revision) {
    return ok({ status: "revision_conflict" as const, revision: server.revision }, 409);
  }
  server.revision += 1;
  server.lastOpId = body.opId;
  server.document = structuredClone(body.document);
  replays.set(body.opId, { revision: server.revision, body: JSON.stringify(body) });
  if (server.loseAcks > 0) {
    server.loseAcks -= 1;
    return networkFailure;
  }
  return ok({ status: "saved" as const, revision: server.revision, replayed: false });
}

function fakeApi(server: FakeServer): AccountApi {
  const replays: Replays = new Map();
  function call<T>(
    method: keyof AccountApi,
    run: () => ApiResult<T>,
    userId?: string,
    body?: unknown,
  ) {
    server.calls.push({ method, ...(userId === undefined ? {} : { userId }), body });
    const queued = server.overrides[method]?.shift();
    const answer = () => (queued ? (queued as ApiResult<T>) : run());
    const held = server.hold?.[method];
    return held ? held.then(answer) : Promise.resolve(answer());
  }
  const signedIn = <T>(value: () => T) => (server.userId ? ok(value()) : unauthenticated);
  /** Private reads honor If-Account-Match like the server: another account's data never leaves. */
  const bound = <T>(userId: string, value: (owner: string) => T) =>
    contextFailure(server, userId) ?? ok(value(userId));
  return {
    getAccount: () =>
      call("getAccount", () =>
        signedIn(() => ({
          authenticated: true as const,
          account: { userId: server.userId ?? "", generation: 1 },
        })),
      ),
    startLogin: () =>
      call("startLogin", () => ok({ authorizationUrl: server.authorizationUrl }), undefined, {}),
    logout: () =>
      call("logout", () => {
        server.userId = null;
        return ok({ loggedOut: true as const });
      }),
    getWorkspace: (userId) => {
      const before = server.beforeWorkspace;
      server.beforeWorkspace = undefined;
      before?.();
      return call(
        "getWorkspace",
        () =>
          bound(userId, (owner) => ({
            userId: owner,
            revision: server.revision,
            lastOpId: server.lastOpId,
            document: structuredClone(server.document),
            quota: server.quota,
          })),
        userId,
      );
    },
    putWorkspace: (userId, body) => {
      server.beforePut?.();
      return call("putWorkspace", () => fakePut(server, replays, userId, body), userId, body);
    },
    deleteAccount: (userId, body) =>
      call(
        "deleteAccount",
        () => {
          const rejected = contextFailure(server, userId);
          if (rejected) return rejected;
          server.userId = null;
          return ok(
            { operationId: "privacy-op", status: server.deletionStatus, fenceGeneration: 2 },
            202,
          );
        },
        userId,
        body,
      ),
    revokeAll: (userId, body) =>
      call(
        "revokeAll",
        () => {
          const rejected = contextFailure(server, userId);
          if (rejected) return rejected;
          server.userId = null;
          return ok({ revoked: true as const });
        },
        userId,
        body,
      ),
    exportData: (userId) =>
      call(
        "exportData",
        () =>
          bound(userId, (owner) => ({
            schemaVersion: 1 as const,
            account: { userId: owner },
            workspace: { userId: owner, revision: server.revision },
          })),
        userId,
      ),
  };
}

export function recordingChannel(): CrossTabChannel & { posted: CrossTabMessage[] } {
  const posted: CrossTabMessage[] = [];
  return {
    posted,
    post: (message) => posted.push(message),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}

type Timer = { callback: () => void; delayMs: number; cancelled: boolean };

/** One clock for every simulated tab: a later device write is always newer. */
let clock = 1_760_000_000_000;

/** Open tabs of one simulated browser: drafts of tabs not in `live` count as closed. */
export type TabRegistry = { live: Set<string>; next: number };

export function createTabRegistry(): TabRegistry {
  return { live: new Set(), next: 0 };
}

type HarnessOptions<T> = {
  channel?: CrossTabChannel;
  store?: WorkspaceStore;
  tabs?: TabRegistry;
  displayed?: T;
  /** Engines with their own guest storage (certified): `value` is that stored guest data. */
  ownGuest?: { value: T | null };
  /** Opening the device store reports a blocked upgrade first. */
  blockedOpen?: boolean;
};

export function createHarness(server: FakeServer, options: HarnessOptions<CalculatorInput> = {}) {
  return createItemHarness(server, calculatorInputCodec, DEFAULT_CALCULATOR_INPUT, options);
}

export function createItemHarness<T>(
  server: FakeServer,
  codec: WorkspaceItemCodec<T>,
  initial: T,
  options: HarnessOptions<T> = {},
) {
  const store = options.store ?? createMemoryWorkspaceStore(codec.type);
  const tabs = options.tabs ?? createTabRegistry();
  tabs.next += 1;
  const tab: TabIdentity = { id: `tab-${tabs.next}`, liveIds: async () => new Set(tabs.live) };
  tabs.live.add(tab.id);
  const channel = options.channel ?? recordingChannel();
  const applied: T[] = [];
  const navigations: string[] = [];
  const downloads: Array<{ fileName: string; text: string }> = [];
  const redirectMarks: boolean[] = [];
  const timers: Timer[] = [];
  let displayed = options.displayed ?? initial;
  let opCount = 0;
  const show = (value: T) => {
    displayed = value;
    applied.push(value);
    // React re-renders and reports the applied value back; it must not count as an edit.
    queueMicrotask(() => controller.notifyLocalChange(value));
  };
  const ownGuest = options.ownGuest;
  const controller: AccountController<T> = new AccountController<T>({
    api: fakeApi(server),
    channel,
    codec,
    calculator: {
      capture: () => displayed,
      apply: show,
      ...(ownGuest
        ? {
            ownGuest: {
              read: () => ownGuest.value,
              show: () => {
                displayed = ownGuest.value ?? codec.empty();
              },
            },
          }
        : {}),
    },
    openStore: async (onBlocked) => {
      if (options.blockedOpen) onBlocked();
      return { store, persistent: true };
    },
    tab,
    newOpId: () => `op-${++opCount}`,
    navigate: (url) => navigations.push(url),
    markRedirectRestore: (pending) => redirectMarks.push(pending),
    download: (fileName, text) => downloads.push({ fileName, text }),
    // Advances on every read so drafts written later are newer.
    now: () => (clock += 1),
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    saveDelayMs: 1_000,
  });
  return {
    controller,
    store,
    tab,
    /** The tab closes: its controller stops and its drafts count as left behind. */
    close() {
      controller.dispose();
      tabs.live.delete(tab.id);
    },
    /** This tab's unsynced draft of the account, if any. */
    async draft(userId = "user-a"): Promise<DraftRecord | null> {
      await controller.whenIdle();
      return (await store.readDrafts(userId)).find((draft) => draft.draftId === tab.id) ?? null;
    },
    channel,
    applied,
    navigations,
    downloads,
    /** Values given to the per-tab "restore pending" marker, in order. */
    redirectMarks,
    get displayed() {
      return displayed;
    },
    view: (): AccountView => controller.getSnapshot().view,
    notice: () => controller.getSnapshot().notice,
    pendingTimers: () => timers.filter((timer) => !timer.cancelled),
    edit(value: T) {
      displayed = value;
      controller.notifyLocalChange(value);
    },
    /** Fires every live timer (repeatedly, for timers scheduled by fired ones) and settles. */
    async runTimers(limit = 10) {
      for (let round = 0; round < limit; round += 1) {
        const live = timers.filter((timer) => !timer.cancelled);
        if (live.length === 0) break;
        for (const timer of live) {
          timer.cancelled = true;
          timer.callback();
        }
        await controller.whenIdle();
      }
    },
  };
}

export function input(blue: number, overrides: Partial<CalculatorInput> = {}): CalculatorInput {
  return { grade: "R", level: 3, exp: 0, stock: { blue, purple: 0, yellow: 0 }, ...overrides };
}
