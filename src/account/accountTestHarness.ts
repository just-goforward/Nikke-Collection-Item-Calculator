import type {
  ConsentGet,
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
import {
  type CalculatorInput,
  DEFAULT_CALCULATOR_INPUT,
  EMPTY_WORKSPACE_DOCUMENT,
} from "./workspaceDocument";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "./workspaceStore";

/** In-memory personal-data server for controller tests (CAS, op replay, account context). */
export type FakeServer = {
  userId: string | null;
  revision: number;
  document: WorkspaceDocument;
  quota: WorkspaceGet["quota"];
  consent: ConsentGet;
  authorizationUrl: string;
  deletionStatus: PrivacyAccepted["status"];
  calls: Array<{ method: keyof AccountApi; userId?: string; body?: unknown }>;
  /** Queued one-shot results per method, returned instead of the simulated behaviour. */
  overrides: Partial<Record<keyof AccountApi, Array<ApiResult<unknown>>>>;
  /** Runs inside putWorkspace before the server answers (e.g. to edit during a save). */
  beforePut?: (() => void) | undefined;
};

export function createFakeServer(overrides: Partial<FakeServer> = {}): FakeServer {
  return {
    userId: "user-a",
    revision: 0,
    document: EMPTY_WORKSPACE_DOCUMENT,
    quota: { bytes: 120, limitBytes: 1_500_000, newArchivingBlocked: false },
    consent: { participation: false, decisionVersion: 1 },
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

function fakeApi(server: FakeServer): AccountApi {
  const replays = new Map<string, { revision: number; body: string }>();
  function call<T>(
    method: keyof AccountApi,
    run: () => ApiResult<T>,
    userId?: string,
    body?: unknown,
  ) {
    server.calls.push({ method, ...(userId === undefined ? {} : { userId }), body });
    const queued = server.overrides[method]?.shift();
    return Promise.resolve(queued ? (queued as ApiResult<T>) : run());
  }
  function put(userId: string, body: WorkspacePut): ApiResult<WorkspacePutResult> {
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
    server.document = structuredClone(body.document);
    replays.set(body.opId, { revision: server.revision, body: JSON.stringify(body) });
    return ok({ status: "saved" as const, revision: server.revision, replayed: false });
  }
  const signedIn = <T>(value: () => T) => (server.userId ? ok(value()) : unauthenticated);
  return {
    getAccount: () =>
      call("getAccount", () =>
        signedIn(() => ({
          authenticated: true as const,
          account: { userId: server.userId ?? "", generation: 1 },
          consent: server.consent,
        })),
      ),
    startLogin: () =>
      call("startLogin", () => ok({ authorizationUrl: server.authorizationUrl }), undefined, {}),
    logout: () =>
      call("logout", () => {
        server.userId = null;
        return ok({ loggedOut: true as const });
      }),
    getWorkspace: () =>
      call("getWorkspace", () =>
        signedIn(() => ({
          revision: server.revision,
          lastOpId: null,
          document: structuredClone(server.document),
          quota: server.quota,
        })),
      ),
    putWorkspace: (userId, body) => {
      server.beforePut?.();
      return call("putWorkspace", () => put(userId, body), userId, body);
    },
    getConsent: () => call("getConsent", () => signedIn(() => server.consent)),
    putConsent: (userId, body) =>
      call(
        "putConsent",
        () => {
          const rejected = contextFailure(server, userId);
          if (rejected) return rejected;
          if (body.baseDecisionVersion !== server.consent.decisionVersion) {
            return failure(409, "revision_conflict");
          }
          server.consent = {
            participation: body.participation,
            decisionVersion: server.consent.decisionVersion + 1,
          };
          return ok(server.consent);
        },
        userId,
        body,
      ),
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
    exportData: () =>
      call("exportData", () =>
        signedIn(() => ({ schemaVersion: 1 as const, workspace: { revision: server.revision } })),
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

export function createHarness(
  server: FakeServer,
  options: { channel?: CrossTabChannel; store?: WorkspaceStore; displayed?: CalculatorInput } = {},
) {
  const store = options.store ?? createMemoryWorkspaceStore();
  const channel = options.channel ?? recordingChannel();
  const applied: CalculatorInput[] = [];
  const navigations: string[] = [];
  const downloads: Array<{ fileName: string; text: string }> = [];
  const timers: Timer[] = [];
  let displayed = options.displayed ?? DEFAULT_CALCULATOR_INPUT;
  let opCount = 0;
  const controller: AccountController = new AccountController({
    api: fakeApi(server),
    channel,
    calculator: {
      capture: () => displayed,
      apply: (input) => {
        displayed = input;
        applied.push(input);
        // React re-renders and reports the applied input back; it must not count as an edit.
        queueMicrotask(() => controller.notifyLocalChange(input));
      },
    },
    openStore: async () => ({ store, persistent: true }),
    newOpId: () => `op-${++opCount}`,
    navigate: (url) => navigations.push(url),
    download: (fileName, text) => downloads.push({ fileName, text }),
    now: () => 1_760_000_000_000,
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
    channel,
    applied,
    navigations,
    downloads,
    get displayed() {
      return displayed;
    },
    view: (): AccountView => controller.getSnapshot().view,
    notice: () => controller.getSnapshot().notice,
    pendingTimers: () => timers.filter((timer) => !timer.cancelled),
    edit(input: CalculatorInput) {
      displayed = input;
      controller.notifyLocalChange(input);
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
