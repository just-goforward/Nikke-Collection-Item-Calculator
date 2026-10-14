import type { ConsentGet, WorkspaceGet } from "../../personal-data/src/contracts";
import { type AccountApi, type ApiFailure, isHttpFailure } from "./api";
import type { CrossTabChannel } from "./crossTab";
import type { CalculatorInput } from "./workspaceDocument";
import type { WorkspaceItemCodec } from "./workspaceItem";
import type { WorkspaceStore } from "./workspaceStore";

export type AccountNotice =
  | "network"
  | "service_unavailable"
  | "login_failed"
  | "rate_limited"
  | "beta_full"
  | "account_switch_requires_logout"
  | "session_expired"
  | "logged_out"
  | "logged_out_elsewhere"
  | "revoked"
  | "deleted"
  | "deletion_pending"
  | "consent_saved"
  | "consent_conflict"
  | "consent_pending"
  | "export_ready"
  | "export_failed"
  | "request_too_large"
  | "archive_quota_reached"
  | "storage_unavailable"
  | "updated_elsewhere"
  | "guest_imported"
  | "logged_out_kept"
  | "logged_out_discarded"
  | "google_issuer_unsupported"
  | "login_flow_expired"
  | "login_error_unknown"
  | "unexpected";

export type StaleReason =
  | "account_changed"
  | "context_stale"
  | "context_required"
  | "signed_in_elsewhere";
export type SyncStatus =
  | "synced"
  | "pending"
  | "saving"
  | "offline"
  | "conflict"
  | "paused"
  | "error";
type AccountBusy = "login" | "logout" | "revoke" | "delete" | "export" | "consent" | null;
export type ConflictChoice = "server" | "local" | "cancel";

export type WorkspaceConflict = {
  serverRevision: number;
  server: CalculatorInput | null;
  local: CalculatorInput;
  /** Item sizes for items that can grow large (the certified session); null otherwise. */
  serverBytes: number | null;
  localBytes: number | null;
  /** The server copy failed validation: it cannot be kept here, only overwritten or left alone. */
  serverUnreadable: boolean;
};

/** personal-data README: POST/PUT/DELETE JSON bodies are limited to 2,000,000 bytes (413). */
export const MAX_REQUEST_BYTES = 2_000_000;

export type SignedInView = {
  phase: "signed-in";
  userId: string;
  consent: ConsentGet;
  /** One-time first-login question: shown while undecided unless dismissed in this tab. */
  consentPrompt: boolean;
  sync: SyncStatus;
  revision: number;
  quota: WorkspaceGet["quota"] | null;
  archivingBlocked: boolean;
  /** Size of this tab's item when the codec reports one (the certified session). */
  itemBytes: number | null;
  /** The last save was refused for size (locally or with 413); the edits stay on this device. */
  tooLarge: boolean;
  conflict: WorkspaceConflict | null;
  /** Guest inputs offered for an explicit copy while the account has no inputs of its own. */
  guestImport: CalculatorInput | null;
  /** Sign-out waiting for the user's choice about unsynced edits on this device. */
  signOutChoice: "logout" | "revoke" | null;
  busy: AccountBusy;
};

export type AccountView =
  | { phase: "loading" }
  | { phase: "guest"; busy: AccountBusy }
  | SignedInView
  | { phase: "stale"; reason: StaleReason };

export type AccountSnapshot = {
  view: AccountView;
  notice: AccountNotice | null;
  /** False when device storage is unavailable and unsaved edits only live in this tab. */
  persistent: boolean;
};

/** Read/write adapter for an engine's existing inputs; internals stay untouched. */
export type CalculatorBridge<T> = {
  capture(): T;
  apply(value: T): void;
  /**
   * Present when the engine keeps its own guest data (the certified guest session). The
   * controller then never stores guest copies: the copy offer reads `read`, and leaving the
   * account calls `show`, which reloads the engine's own guest data.
   */
  ownGuest?: { read(): T | null; show(): void };
};

export type AccountControllerDeps<T> = {
  api: AccountApi;
  channel: CrossTabChannel;
  codec: WorkspaceItemCodec<T>;
  calculator: CalculatorBridge<T>;
  openStore(): Promise<{ store: WorkspaceStore; persistent: boolean }>;
  newOpId(): string;
  navigate(url: string): void;
  download(fileName: string, text: string): void;
  now(): number;
  /** Returns a cancel function. */
  schedule(callback: () => void, delayMs: number): () => void;
  saveDelayMs: number;
};

export function noticeFor(failure: ApiFailure): AccountNotice {
  if (failure.kind === "network") return "network";
  switch (failure.code) {
    case "rate_limited":
    case "beta_full":
    case "account_switch_requires_logout":
    case "request_too_large":
      return failure.code;
    case "consent_change_pending":
      return "consent_pending";
    case "unauthenticated":
      return "session_expired";
    default:
      return failure.status >= 500 ? "service_unavailable" : "unexpected";
  }
}

/** 409 account_context_stale and 428 account_context_required both stop this tab's writes. */
export function staleReasonFor(failure: ApiFailure): StaleReason | null {
  if (isHttpFailure(failure, 409, "account_context_stale")) return "context_stale";
  if (isHttpFailure(failure, 428)) return "context_required";
  return null;
}

export function isRetryable(failure: ApiFailure): boolean {
  return failure.kind === "network" || failure.status >= 500 || failure.status === 429;
}

export function exportFileName(now: number): string {
  return `collection-kit-account-export-${new Date(now).toISOString().slice(0, 10)}.json`;
}
