import type {
  WorkspaceDocument,
  WorkspaceGet,
  WorkspacePutResult,
} from "../../personal-data/src/contracts";
import {
  AccountControllerBase,
  type PendingOp,
  type Session,
  UNKNOWN_BASE_KEY,
} from "./accountControllerBase";
import {
  type ConflictChoice,
  isRetryable,
  MAX_REQUEST_BYTES,
  noticeFor,
  staleReasonFor,
  type WorkspaceConflict,
} from "./accountState";
import { type ApiFailure, isHttpFailure } from "./api";
import { type ItemRead, utf8Bytes } from "./workspaceItem";
import type { DraftRecord } from "./workspaceStore";

const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

export function nextBackoff(previousMs: number): number {
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, previousMs * 2));
}

/** Workspace sync of the shown item: saves, acknowledgements, conflicts and draft recovery. */
export abstract class AccountSync<T> extends AccountControllerBase<T> {
  /** The session ended with 401: leave for guest data, keeping unsynced drafts. */
  protected abstract expire(): Promise<void>;

  /** Called with the engine's current value after every change. */
  notifyLocalChange(value: T) {
    const session = this.session;
    const { codec } = this.deps;
    if (!session) return;
    const key = codec.key(value);
    if (key === codec.key(session.local)) return;
    session.local = value;
    // A sent save without an answer may have committed another value: reverting to the synced
    // value is still an edit until that operation is reconciled.
    session.dirty = key !== session.syncedKey || session.unacked.length > 0;
    // Durable at once, independent of any request in flight.
    void this.persist(session);
    const view = this.signedIn();
    if (!view) return;
    const itemBytes = codec.bytes(value);
    if (itemBytes !== view.itemBytes) this.patchSignedIn({ itemBytes });
    if (view.sync === "conflict" || view.sync === "paused" || view.sync === "saving") return;
    if (session.dirty) {
      this.patchSignedIn({ sync: "pending" });
      this.scheduleSave(session, this.deps.saveDelayMs);
      return;
    }
    this.markClean(session);
  }

  /** "Sync now" and the online event: save edits, or catch up with an announced revision. */
  protected async sync() {
    const session = this.session;
    if (!session) return;
    this.cancelTimer(session);
    if (!session.dirty && session.announcedRevision > session.revision) {
      await this.refresh(session);
      return;
    }
    await this.save();
  }

  protected async save() {
    const session = this.session;
    const view = this.signedIn();
    if (!session || !view || !session.dirty || view.sync === "conflict" || view.sync === "paused") {
      return;
    }
    this.cancelTimer(session);
    if (session.serverUnreadable) {
      // Only the explicit overwrite choice may replace an unreadable server copy.
      this.enterConflict(session, session.revision, session.serverDocument, false);
      return;
    }
    const op = this.operation(session);
    const body = {
      opId: op.opId,
      baseRevision: op.baseRevision,
      document: op.document,
      action: { kind: "save" as const },
    };
    if (utf8Bytes(JSON.stringify(body)) > MAX_REQUEST_BYTES) {
      // Never sent: the server would refuse it with 413. The edits stay on this device.
      session.pendingOp = null;
      this.patchSignedIn({ sync: "error", tooLarge: true });
      this.notify("request_too_large");
      return;
    }
    session.pendingOp = op;
    this.patchSignedIn({ sync: "saving" });
    const result = await this.deps.api.putWorkspace(session.userId, body);
    if (this.session !== session) return;
    if (result.ok) await this.afterPut(session, op, result.value);
    else await this.afterPutFailure(session, op, result.failure);
  }

  /** A retry of unchanged edits reuses its opId and body so a lost acknowledgement replays. */
  private operation(session: Session<T>): PendingOp {
    const key = this.deps.codec.key(session.local);
    const pending = session.pendingOp;
    if (pending?.key === key && pending.baseRevision === session.revision) return pending;
    return {
      opId: this.deps.newOpId(),
      key,
      baseRevision: session.revision,
      document: this.deps.codec.write(session.serverDocument, session.local),
    };
  }

  private async afterPut(session: Session<T>, op: PendingOp, result: WorkspacePutResult) {
    switch (result.status) {
      case "saved":
        // A replay reports the original revision; saves from other devices may have followed.
        if (result.replayed) {
          session.announcedRevision = Math.max(session.announcedRevision, result.revision + 1);
        }
        this.acknowledged(session, op, result.revision, op.document);
        this.patchSignedIn({ tooLarge: false });
        return;
      case "revision_conflict":
        session.announcedRevision = Math.max(session.announcedRevision, result.revision);
        await this.conflictFromServer(session);
        return;
      case "op_id_conflict":
        session.pendingOp = null;
        this.patchSignedIn({ sync: "pending" });
        this.scheduleSave(session, 0);
        return;
      case "archive_quota_reached":
        session.pendingOp = null;
        session.revision = Math.max(session.revision, result.revision);
        this.patchSignedIn({ archivingBlocked: true, sync: "error" });
        this.notify("archive_quota_reached");
        return;
      case "archive_id_conflict":
        session.pendingOp = null;
        this.patchSignedIn({ sync: "error" });
        this.notify("unexpected");
        return;
    }
  }

  /**
   * Records the server state an operation produced and continues from there. A replayed
   * acknowledgement reports its original revision; newer local edits stay pending.
   */
  private acknowledged(
    session: Session<T>,
    op: PendingOp,
    revision: number,
    document: WorkspaceDocument,
  ) {
    session.pendingOp = null;
    session.unacked = [];
    session.retryMs = 0;
    session.serverDocument = document;
    session.serverUnreadable = false;
    session.conflict = null;
    session.syncedKey = op.key;
    session.revision = Math.max(session.revision, revision);
    session.dirty = this.deps.codec.key(session.local) !== op.key;
    void this.persist(session);
    this.deps.channel.post({
      type: "revision",
      userId: session.userId,
      revision: session.revision,
    });
    this.patchSignedIn({ revision: session.revision, conflict: null });
    if (session.dirty) {
      this.patchSignedIn({ sync: "pending" });
      this.scheduleSave(session, this.deps.saveDelayMs);
    } else this.markClean(session);
  }

  /** Never "synced" while another tab announced a newer revision: follow it first. */
  private markClean(session: Session<T>) {
    this.cancelTimer(session);
    if (session.announcedRevision > session.revision) {
      this.patchSignedIn({ sync: "pending" });
      void this.enqueue(() => this.refresh(session));
      return;
    }
    this.patchSignedIn({ sync: "synced" });
    if (session.recovering.length > 0) void this.enqueue(() => this.recoverNext(session));
  }

  private async afterPutFailure(session: Session<T>, op: PendingOp | null, failure: ApiFailure) {
    const stale = staleReasonFor(failure);
    if (stale) {
      this.markStale(stale);
      return;
    }
    if (isHttpFailure(failure, 401)) {
      await this.expire();
      return;
    }
    if (isRetryable(failure)) {
      // The outcome is unknown: the server may have committed it (see `acknowledge`).
      if (op && !session.unacked.some((entry) => entry.opId === op.opId)) session.unacked.push(op);
      session.retryMs = nextBackoff(session.retryMs);
      this.patchSignedIn({ sync: "offline" });
      this.scheduleSave(session, session.retryMs);
      return;
    }
    session.pendingOp = null;
    this.patchSignedIn({ sync: "error", tooLarge: isHttpFailure(failure, 413) });
    this.notify(noticeFor(failure));
  }

  private async conflictFromServer(session: Session<T>) {
    session.pendingOp = null;
    const fresh = await this.deps.api.getWorkspace(session.userId);
    if (this.session !== session) return;
    if (!fresh.ok) {
      await this.afterPutFailure(session, null, fresh.failure);
      return;
    }
    this.applyFresh(session, fresh.value);
  }

  /** Fetches this account's workspace and brings the session up to date with it. */
  protected async refresh(session: Session<T>) {
    const fresh = await this.deps.api.getWorkspace(session.userId);
    if (this.session !== session) return;
    if (fresh.ok) this.applyFresh(session, fresh.value);
    else await this.readFailure(fresh.failure);
  }

  protected async readFailure(failure: ApiFailure) {
    const stale = staleReasonFor(failure);
    if (stale) this.markStale(stale);
    else if (isHttpFailure(failure, 401)) await this.expire();
    else this.notify(noticeFor(failure));
  }

  private applyFresh(session: Session<T>, fresh: WorkspaceGet) {
    // The server's answer is authoritative; later announcements are handled when they arrive.
    session.announcedRevision = fresh.revision;
    this.patchSignedIn({
      quota: fresh.quota,
      archivingBlocked: fresh.quota.newArchivingBlocked,
    });
    const acked = session.unacked.find((op) => op.opId === fresh.lastOpId);
    if (acked) {
      // The server's latest operation is one whose acknowledgement was lost: it is ours.
      this.acknowledged(session, acked, fresh.revision, fresh.document);
      return;
    }
    if (session.unacked.length > 0) {
      // None of the unanswered operations is the server's latest: the server state decides.
      session.unacked = [];
      session.dirty = this.localKey(session) !== session.syncedKey;
    }
    const server = this.deps.codec.read(fresh.document);
    if (session.dirty || server.status === "unreadable") {
      this.enterConflict(session, fresh.revision, fresh.document, true);
      return;
    }
    session.serverDocument = fresh.document;
    session.revision = fresh.revision;
    session.syncedKey = this.itemKey(server) ?? UNKNOWN_BASE_KEY;
    session.serverUnreadable = false;
    session.conflict = null;
    // Another engine's save leaves this item unchanged; re-applying would discard its results.
    if (server.status === "value" && this.deps.codec.key(server.value) !== this.localKey(session)) {
      this.applyInput(session, server.value);
    }
    void this.persist(session);
    this.patchSignedIn({ revision: session.revision, conflict: null });
    this.markClean(session);
  }

  private localKey(session: Session<T>) {
    return this.deps.codec.key(session.local);
  }

  /** `rebase`: the local base is known, so a server change to other items only is not a conflict. */
  protected enterConflict(
    session: Session<T>,
    revision: number,
    document: WorkspaceDocument,
    rebase: boolean,
  ) {
    const server = this.deps.codec.read(document);
    const serverKey = this.itemKey(server);
    if (serverKey === this.localKey(session)) {
      // Both sides already hold the same value: adopt the server revision, nothing to choose.
      session.serverDocument = document;
      session.revision = revision;
      session.syncedKey = serverKey;
      session.serverUnreadable = false;
      session.dirty = false;
      session.unacked = [];
      session.conflict = null;
      void this.persist(session);
      this.patchSignedIn({ revision, conflict: null });
      this.markClean(session);
      return;
    }
    if (rebase && serverKey !== null && serverKey === session.syncedKey) {
      // Only other items (e.g. the other engine's) changed: this edit applies on top unchanged.
      session.serverDocument = document;
      session.revision = revision;
      session.pendingOp = null;
      void this.persist(session);
      this.patchSignedIn({ revision, sync: "pending" });
      this.scheduleSave(session, 0);
      return;
    }
    session.serverUnreadable = server.status === "unreadable";
    session.conflict = { revision, document };
    this.patchSignedIn({
      sync: "conflict",
      conflict: this.conflictView(session, revision, server),
    });
  }

  private conflictView(
    session: Session<T>,
    revision: number,
    server: ItemRead<T>,
  ): WorkspaceConflict {
    const { codec } = this.deps;
    return {
      serverRevision: revision,
      server: server.status === "value" ? codec.summary(server.value) : null,
      local: codec.summary(session.local),
      serverBytes: server.status === "value" ? codec.bytes(server.value) : null,
      localBytes: codec.bytes(session.local),
      serverUnreadable: server.status === "unreadable",
    };
  }

  protected async applyConflictChoice(choice: ConflictChoice) {
    const session = this.session;
    const conflict = session?.conflict;
    if (!session || !conflict) return;
    const server = this.deps.codec.read(conflict.document);
    // An unreadable server copy can only be overwritten or left alone.
    if (choice === "server" && server.status === "unreadable") return;
    session.conflict = null;
    if (choice === "cancel") {
      this.patchSignedIn({ sync: "paused", conflict: null });
      return;
    }
    session.serverDocument = conflict.document;
    session.revision = conflict.revision;
    session.pendingOp = null;
    session.serverUnreadable = false;
    session.syncedKey = this.itemKey(server) ?? UNKNOWN_BASE_KEY;
    if (choice === "server") {
      session.dirty = false;
      this.applyInput(session, server.status === "value" ? server.value : this.deps.codec.empty());
      await this.persist(session);
      this.patchSignedIn({ conflict: null, revision: session.revision });
      this.markClean(session);
      return;
    }
    session.dirty = true;
    void this.persist(session);
    this.patchSignedIn({ sync: "pending", conflict: null, revision: session.revision });
    await this.save();
  }

  /** "Resolve conflict" after a cancel: always re-reads the server and asks again if needed. */
  protected async resume() {
    const session = this.session;
    if (!session || this.signedIn()?.sync !== "paused") return;
    await this.refresh(session);
  }

  protected async remoteRevision(revision: number) {
    const session = this.session;
    const view = this.signedIn();
    if (!session || !view) return;
    session.announcedRevision = Math.max(session.announcedRevision, revision);
    if (revision <= session.revision) return;
    if (session.dirty || view.sync !== "synced") {
      // The next save rebases or asks; a clean save catches up (see `markClean`).
      this.notify("updated_elsewhere");
      return;
    }
    await this.refresh(session);
  }

  // ---- device drafts ----

  /** This tab's own draft and drafts of tabs that are no longer open, newest first. */
  protected async recoverableDrafts(userId: string): Promise<DraftRecord[]> {
    const { tab } = this.deps;
    const [drafts, live] = await Promise.all([
      this.storage((store) => store.readDrafts(userId), []),
      tab.liveIds(),
    ]);
    return drafts.filter((draft) => draft.draftId === tab.id || !live.has(draft.draftId));
  }

  private canRecover(session: Session<T>) {
    return (
      this.session === session &&
      !session.dirty &&
      session.conflict === null &&
      this.signedIn()?.sync === "synced"
    );
  }

  /** Recovers the next draft once the session is settled; each goes through save or conflict. */
  protected async recoverNext(session: Session<T>) {
    while (session.recovering.length > 0) {
      if (!this.canRecover(session)) return;
      const next = session.recovering.shift();
      if (next && (await this.recoverDraft(session, next))) return;
    }
  }

  /**
   * Adopts a draft's edits: first moved atomically into this tab's draft on the device (another
   * tab can never adopt it too, and a refused write leaves it where it was), then shown and saved.
   * False when there was nothing to recover.
   */
  private async recoverDraft(session: Session<T>, draft: DraftRecord): Promise<boolean> {
    const { codec, tab } = this.deps;
    const stored = this.readValue(draft.document);
    if (stored === null || codec.key(stored) === session.syncedKey) {
      if (draft.draftId !== tab.id) {
        await this.storage(
          (store) => store.removeDrafts(session.userId, [draft.draftId]),
          undefined,
        );
      }
      return false;
    }
    const serverRevision = session.revision;
    const sameItem = draft.baseKey !== null && draft.baseKey === session.syncedKey;
    const knownBase =
      !session.serverUnreadable && (draft.baseRevision === serverRevision || sameItem);
    // Unknown base: the edits were made on another revision whose item is unknown here. Keep that
    // base so a save can only conflict, never overwrite newer server data without a choice.
    const base = knownBase
      ? { revision: serverRevision, syncedKey: session.syncedKey }
      : { revision: draft.baseRevision, syncedKey: UNKNOWN_BASE_KEY };
    const record = this.draftRecord({ ...session, ...base, local: stored });
    const claim = await this.claimDraft(draft.draftId, record);
    // Gone: another tab adopted it first. A session left meanwhile keeps the claimed draft.
    if (claim === "gone") return false;
    if (this.session !== session) return true;
    if (claim === "failed") {
      // Left on the device untouched; retried once the session settles again.
      session.recovering.unshift(draft);
      this.notify("draft_recovery_failed");
      return true;
    }
    session.revision = base.revision;
    session.syncedKey = base.syncedKey;
    session.dirty = true;
    this.applyInput(session, stored);
    if (draft.draftId !== tab.id) this.notify("draft_recovered");
    if (!knownBase) {
      this.enterConflict(session, serverRevision, session.serverDocument, false);
      return true;
    }
    this.patchSignedIn({ sync: "pending" });
    await this.save();
    return true;
  }
}
