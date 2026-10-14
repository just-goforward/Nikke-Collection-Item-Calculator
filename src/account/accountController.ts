import type {
  ConsentGet,
  WorkspaceDocument,
  WorkspacePutResult,
} from "../../personal-data/src/contracts";
import {
  AccountControllerBase,
  type PendingOp,
  type Session,
  UNKNOWN_BASE_KEY,
} from "./accountControllerBase";
import {
  type AccountControllerDeps,
  type AccountNotice,
  type AccountView,
  type ConflictChoice,
  exportFileName,
  isRetryable,
  MAX_REQUEST_BYTES,
  noticeFor,
  type SignedInView,
  staleReasonFor,
  type WorkspaceConflict,
} from "./accountState";
import { type ApiFailure, failureCode, isGoogleAuthorizationUrl, isHttpFailure } from "./api";
import type { CrossTabMessage } from "./crossTab";
import { EMPTY_WORKSPACE_DOCUMENT } from "./workspaceDocument";
import { type ItemRead, utf8Bytes } from "./workspaceItem";
import type { AccountRecord } from "./workspaceStore";

const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

function sameIdentity(a: AccountView, b: AccountView): boolean {
  if (a.phase !== b.phase) return false;
  return a.phase !== "signed-in" || (b.phase === "signed-in" && a.userId === b.userId);
}

/** What the account dialogs may call; independent of the engine's item type. */
export type AccountUi = Omit<AccountController<unknown>, "notifyLocalChange">;

export class AccountController<T> extends AccountControllerBase<T> {
  private pendingConsent: { participation: boolean; base: number; opId: string } | null = null;
  private pendingDeleteOpId: string | null = null;
  private consentDismissed = false;
  /** The page-level account check timed out while loading; a late result must not apply. */
  private bootAbandoned = false;
  private readonly unsubscribe: () => void;

  constructor(deps: AccountControllerDeps<T>) {
    super(deps);
    this.unsubscribe = deps.channel.subscribe((message) => {
      void this.enqueue(() => this.handleMessage(message));
    });
  }

  dispose() {
    this.disposed = true;
    if (this.session) this.cancelTimer(this.session);
    this.unsubscribe();
    this.deps.channel.close();
  }

  start() {
    return this.enqueue(() => this.load());
  }
  checkSession() {
    return this.enqueue(() => this.recheck());
  }
  login() {
    return this.enqueue(() => this.beginLogin());
  }
  logout() {
    return this.enqueue(() => this.endSession("logout"));
  }
  revokeAllSessions() {
    return this.enqueue(() => this.endSession("revoke"));
  }
  deleteAccount() {
    return this.enqueue(() => this.removeAccount());
  }
  exportData() {
    return this.enqueue(() => this.downloadExport());
  }
  setConsent(participation: boolean) {
    return this.enqueue(() => this.saveConsent(participation));
  }
  resolveConflict(choice: ConflictChoice) {
    return this.enqueue(() => this.applyConflictChoice(choice));
  }
  resumeSync() {
    return this.enqueue(() => this.resume());
  }
  /** Runs a scheduled save immediately (also used by "Sync now" and the online event). */
  syncNow() {
    if (this.session) this.cancelTimer(this.session);
    return this.enqueue(() => this.save());
  }
  /** Explicit, never automatic: copies the stored guest inputs into an account without inputs. */
  copyGuestInputs() {
    return this.enqueue(() => this.importGuestInputs());
  }
  dismissGuestImport() {
    if (this.session) this.session.guestOffer = null;
    this.patchSignedIn({});
  }
  /** Completes a sign-out that found unsynced edits; keeping them is the default choice. */
  confirmSignOut(keepUnsynced: boolean) {
    return this.enqueue(() => this.finishSignOut(keepUnsynced));
  }
  cancelSignOut() {
    this.patchSignedIn({ signOutChoice: null, busy: null });
  }
  /** Page-level timeout: continue with guest data now; a late sign-in only asks for a reload. */
  bootTimedOut() {
    if (this.snapshot.view.phase !== "loading") return;
    this.bootAbandoned = true;
    this.setView({ phase: "guest", busy: null });
    this.notify("account_check_timeout");
  }
  dismissConsentPrompt() {
    this.consentDismissed = true;
    this.patchSignedIn({ consentPrompt: false });
  }

  /** Called with the engine's current value after every change. */
  notifyLocalChange(value: T) {
    const session = this.session;
    const { codec } = this.deps;
    if (!session) return;
    const key = codec.key(value);
    if (key === codec.key(session.local)) return;
    session.local = value;
    session.dirty = key !== session.syncedKey;
    void this.enqueue(() => this.persistAccount(session));
    const view = this.signedIn();
    if (!view) return;
    const itemBytes = codec.bytes(value);
    if (itemBytes !== view.itemBytes) this.patchSignedIn({ itemBytes });
    if (view.sync === "conflict" || view.sync === "paused" || view.sync === "saving") return;
    if (!session.dirty) {
      this.cancelTimer(session);
      this.patchSignedIn({ sync: "synced" });
      return;
    }
    this.patchSignedIn({ sync: "pending" });
    this.scheduleSave(session, this.deps.saveDelayMs);
  }

  // ---- boot, guest and account entry ----

  private async load() {
    await this.ensureStore();
    const result = await this.deps.api.getAccount();
    if (this.bootAbandoned) {
      this.abandonedBootResult(result.ok);
      return;
    }
    if (result.ok) {
      await this.enterAccount(result.value.account.userId, result.value.consent);
      return;
    }
    await this.enterGuest("boot");
    if (!isHttpFailure(result.failure, 401)) this.notify(noticeFor(result.failure));
  }

  private abandonedBootResult(signedIn: boolean) {
    this.bootAbandoned = false;
    if (signedIn) this.markStale("account_check_late");
  }

  /** "boot" restores guest inputs only after an abandoned sign-in; "restore" always does. */
  private async enterGuest(mode: "boot" | "restore") {
    this.session = null;
    const { calculator, codec } = this.deps;
    if (calculator.ownGuest) {
      // The engine keeps its own guest data; at boot it is already shown.
      if (mode === "restore") calculator.ownGuest.show();
      this.setView({ phase: "guest", busy: null });
      return;
    }
    const guest = await this.storage((store) => store.readGuest(), null);
    const value = guest ? this.readValue(guest.document) : null;
    if (mode === "restore") calculator.apply(value ?? codec.empty());
    else if (guest?.restoreOnReturn && value !== null) calculator.apply(value);
    if (guest?.restoreOnReturn) {
      await this.storage(
        (store) => store.writeGuest({ ...guest, restoreOnReturn: false }),
        undefined,
      );
    }
    this.setView({ phase: "guest", busy: null });
  }

  private readValue(document: WorkspaceDocument): T | null {
    const read = this.deps.codec.read(document);
    return read.status === "value" ? read.value : null;
  }

  private async readGuestValue(): Promise<T | null> {
    const own = this.deps.calculator.ownGuest;
    if (own) return own.read();
    const guest = await this.storage((store) => store.readGuest(), null);
    if (guest?.restoreOnReturn) {
      await this.storage(
        (store) => store.writeGuest({ ...guest, restoreOnReturn: false }),
        undefined,
      );
    }
    return guest ? this.readValue(guest.document) : null;
  }

  private async enterAccount(userId: string, consent: ConsentGet) {
    const [workspace, local, guestValue] = await Promise.all([
      this.deps.api.getWorkspace(),
      this.storage((store) => store.readAccount(userId), null),
      this.readGuestValue(),
    ]);
    if (this.bootAbandoned) {
      this.abandonedBootResult(true);
      return;
    }
    if (!workspace.ok) {
      await this.workspaceUnavailable(userId, consent, workspace.failure);
      return;
    }
    const { calculator, codec } = this.deps;
    const server = codec.read(workspace.value.document);
    const offerGuest =
      server.status === "absent" && guestValue !== null && !codec.isEmpty(guestValue);
    let initial: T;
    if (server.status === "value") initial = server.value;
    // Engines with their own guest data must not show it as this account's data.
    else initial = calculator.ownGuest ? codec.empty() : calculator.capture();
    const session: Session<T> = {
      userId,
      serverDocument: workspace.value.document,
      revision: workspace.value.revision,
      syncedKey: this.itemKey(server) ?? UNKNOWN_BASE_KEY,
      local: initial,
      dirty: false,
      pendingOp: null,
      conflict: null,
      serverUnreadable: server.status === "unreadable",
      guestOffer:
        offerGuest && guestValue !== null
          ? { value: guestValue, summary: codec.summary(guestValue) }
          : null,
      retryMs: 0,
      cancelTimer: null,
    };
    this.session = session;
    this.setView(
      this.signedInView(userId, consent, {
        consentPrompt: consent.participation === null && !this.consentDismissed,
        revision: session.revision,
        quota: workspace.value.quota,
        archivingBlocked: workspace.value.quota.newArchivingBlocked,
        itemBytes: codec.bytes(initial),
      }),
    );
    this.deps.channel.post({ type: "account", userId });
    await this.reconcile(session, server.status === "value", local);
  }

  private async workspaceUnavailable(userId: string, consent: ConsentGet, failure: ApiFailure) {
    if (isHttpFailure(failure, 401)) {
      await this.enterGuest("boot");
      return;
    }
    // Signed in, but without a server base revision nothing may be saved; recheck retries entry.
    this.setView(this.signedInView(userId, consent, { sync: "error" }));
    this.notify(noticeFor(failure));
  }

  private signedInView(
    userId: string,
    consent: ConsentGet,
    fields: Partial<Omit<SignedInView, "phase" | "userId" | "consent">>,
  ): SignedInView {
    return {
      phase: "signed-in",
      userId,
      consent,
      consentPrompt: false,
      sync: "synced",
      revision: 0,
      quota: null,
      archivingBlocked: false,
      itemBytes: null,
      tooLarge: false,
      conflict: null,
      guestImport: this.guestImport(),
      signOutChoice: null,
      busy: null,
      ...fields,
    };
  }

  private async importGuestInputs() {
    const session = this.session;
    const offer = this.guestImport() === null ? null : session?.guestOffer;
    if (!session || !offer) return;
    session.guestOffer = null;
    this.applyInput(session, offer.value);
    session.dirty = this.deps.codec.key(offer.value) !== session.syncedKey;
    await this.persistAccount(session);
    this.patchSignedIn({ sync: "pending" });
    this.notify("guest_imported");
    await this.save();
  }

  /** Unsynced edits from an earlier visit survive, but never silently replace newer server data. */
  private async reconcile(
    session: Session<T>,
    serverHasValue: boolean,
    local: AccountRecord | null,
  ) {
    const { codec } = this.deps;
    const stored = local?.dirty ? this.readValue(local.document) : null;
    if (!local || stored === null || codec.key(stored) === session.syncedKey) {
      if (serverHasValue || this.deps.calculator.ownGuest) this.applyInput(session, session.local);
      await this.persistAccount(session);
      if (session.serverUnreadable) {
        this.enterConflict(session, session.revision, session.serverDocument, false);
      }
      return;
    }
    this.applyInput(session, stored);
    session.dirty = true;
    if (local.baseRevision === session.revision && !session.serverUnreadable) {
      await this.persistAccount(session);
      this.patchSignedIn({ sync: "pending" });
      await this.save();
      return;
    }
    // The edits were made on an older revision whose contents are unknown here: keep that base so
    // a save can only conflict, never overwrite the newer server data without a choice.
    const serverRevision = session.revision;
    session.revision = local.baseRevision;
    session.syncedKey = UNKNOWN_BASE_KEY;
    await this.persistAccount(session);
    this.enterConflict(session, serverRevision, session.serverDocument, false);
  }

  // ---- workspace sync ----

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
    const key = this.deps.codec.key(session.local);
    const reusable =
      session.pendingOp?.key === key && session.pendingOp.baseRevision === session.revision;
    const op: PendingOp =
      reusable && session.pendingOp
        ? session.pendingOp
        : {
            opId: this.deps.newOpId(),
            key,
            baseRevision: session.revision,
            document: this.deps.codec.write(session.serverDocument, session.local),
          };
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
    else await this.afterPutFailure(session, result.failure);
  }

  private async afterPut(session: Session<T>, op: PendingOp, result: WorkspacePutResult) {
    switch (result.status) {
      case "saved":
        await this.saved(session, op, result.revision);
        return;
      case "revision_conflict":
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

  /** A replayed acknowledgement reports its original revision; local newer edits stay pending. */
  private async saved(session: Session<T>, op: PendingOp, revision: number) {
    session.pendingOp = null;
    session.retryMs = 0;
    session.serverDocument = op.document;
    session.serverUnreadable = false;
    session.syncedKey = op.key;
    session.revision = Math.max(session.revision, revision);
    session.dirty = this.deps.codec.key(session.local) !== op.key;
    await this.persistAccount(session);
    this.deps.channel.post({
      type: "revision",
      userId: session.userId,
      revision: session.revision,
    });
    this.patchSignedIn({
      revision: session.revision,
      sync: session.dirty ? "pending" : "synced",
      tooLarge: false,
    });
    if (session.dirty) this.scheduleSave(session, this.deps.saveDelayMs);
  }

  private async afterPutFailure(session: Session<T>, failure: ApiFailure) {
    const stale = staleReasonFor(failure);
    if (stale) {
      this.markStale(stale);
      return;
    }
    if (isHttpFailure(failure, 401)) {
      await this.leave("session_expired", null, false);
      return;
    }
    if (isRetryable(failure)) {
      // The same opId and body are retried so a lost acknowledgement replays instead of duplicating.
      session.retryMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, session.retryMs * 2));
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
    const fresh = await this.deps.api.getWorkspace();
    if (this.session !== session) return;
    if (!fresh.ok) {
      await this.afterPutFailure(session, fresh.failure);
      return;
    }
    this.patchSignedIn({
      quota: fresh.value.quota,
      archivingBlocked: fresh.value.quota.newArchivingBlocked,
    });
    this.enterConflict(session, fresh.value.revision, fresh.value.document, true);
  }

  /** `rebase`: the local base is known, so a server change to other items only is not a conflict. */
  private enterConflict(
    session: Session<T>,
    revision: number,
    document: WorkspaceDocument,
    rebase: boolean,
  ) {
    const server = this.deps.codec.read(document);
    const serverKey = this.itemKey(server);
    if (serverKey === this.deps.codec.key(session.local)) {
      // Both sides already hold the same value: adopt the server revision, nothing to choose.
      session.serverDocument = document;
      session.revision = revision;
      session.syncedKey = serverKey;
      session.serverUnreadable = false;
      session.dirty = false;
      this.patchSignedIn({ revision, sync: "synced", conflict: null });
      void this.enqueue(() => this.persistAccount(session));
      return;
    }
    if (rebase && serverKey !== null && serverKey === session.syncedKey) {
      // Only other items (e.g. the other engine's) changed: this edit applies on top unchanged.
      session.serverDocument = document;
      session.revision = revision;
      session.pendingOp = null;
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

  private async applyConflictChoice(choice: ConflictChoice) {
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
      await this.persistAccount(session);
      this.patchSignedIn({ sync: "synced", conflict: null, revision: session.revision });
      return;
    }
    session.dirty = true;
    this.patchSignedIn({ sync: "pending", conflict: null, revision: session.revision });
    await this.save();
  }

  private async resume() {
    if (this.signedIn()?.sync !== "paused" || !this.session) return;
    this.patchSignedIn({ sync: "pending" });
    await this.save();
  }

  private async remoteRevision(revision: number) {
    const session = this.session;
    const view = this.signedIn();
    if (!session || !view || revision <= session.revision) return;
    if (session.dirty || view.sync !== "synced") {
      this.notify("updated_elsewhere");
      return;
    }
    const fresh = await this.deps.api.getWorkspace();
    if (this.session !== session) return;
    if (!fresh.ok || session.dirty) {
      this.notify(fresh.ok ? "updated_elsewhere" : noticeFor(fresh.failure));
      return;
    }
    const { codec } = this.deps;
    const server = codec.read(fresh.value.document);
    if (server.status === "unreadable") {
      this.enterConflict(session, fresh.value.revision, fresh.value.document, false);
      return;
    }
    session.serverDocument = fresh.value.document;
    session.revision = fresh.value.revision;
    session.syncedKey = this.itemKey(server) ?? UNKNOWN_BASE_KEY;
    // Another engine's save leaves this item unchanged; re-applying would discard its results.
    if (server.status === "value" && codec.key(server.value) !== codec.key(session.local)) {
      this.applyInput(session, server.value);
    }
    await this.persistAccount(session);
    this.patchSignedIn({
      revision: session.revision,
      quota: fresh.value.quota,
      archivingBlocked: fresh.value.quota.newArchivingBlocked,
      sync: "synced",
    });
  }

  // ---- cross-tab and stale-tab handling ----

  private async handleMessage(message: CrossTabMessage) {
    const view = this.snapshot.view;
    if (view.phase === "loading" || view.phase === "stale") return;
    if (view.phase === "guest") {
      if (message.type === "account" && view.busy !== "login")
        this.markStale("signed_in_elsewhere");
      return;
    }
    if (message.userId !== view.userId) {
      if (message.type === "account") this.markStale("account_changed");
      return;
    }
    if (message.type === "logged-out") await this.leave("logged_out_elsewhere", null, false);
    else if (message.type === "deleted") await this.leave("deleted", null, true);
    else if (message.type === "revision") await this.remoteRevision(message.revision);
    else if (message.type === "consent") await this.refreshConsent(view.userId, null, null);
  }

  /** Detects sign-in changes that happened while this tab was hidden or its broadcast was missed. */
  private async recheck() {
    const view = this.snapshot.view;
    if (view.phase === "loading" || view.phase === "stale") return;
    if (view.phase === "guest" && view.busy === "login") return;
    const result = await this.deps.api.getAccount();
    if (!sameIdentity(view, this.snapshot.view)) return;
    if (view.phase === "guest") {
      if (result.ok) this.markStale("signed_in_elsewhere");
      return;
    }
    if (!result.ok) {
      if (isHttpFailure(result.failure, 401)) await this.leave("logged_out_elsewhere", null, false);
      return;
    }
    if (result.value.account.userId !== view.userId) {
      this.markStale("account_changed");
      return;
    }
    if (!this.session) {
      await this.enterAccount(view.userId, result.value.consent);
      return;
    }
    this.patchSignedIn({
      consent: result.value.consent,
      consentPrompt: result.value.consent.participation === null && !this.consentDismissed,
    });
  }

  // ---- login, logout, revoke, deletion, export ----

  private async beginLogin() {
    if (this.snapshot.view.phase !== "guest") return;
    this.setView({ phase: "guest", busy: "login" });
    // Engines with their own guest storage already keep the guest data across the redirect.
    const { calculator, codec } = this.deps;
    const document = calculator.ownGuest
      ? null
      : codec.write(EMPTY_WORKSPACE_DOCUMENT, calculator.capture());
    const updatedAt = this.deps.now();
    const remember = (restoreOnReturn: boolean) =>
      document
        ? this.storage(
            (store) => store.writeGuest({ document, restoreOnReturn, updatedAt }),
            undefined,
          )
        : Promise.resolve();
    await remember(true);
    const result = await this.deps.api.startLogin();
    if (result.ok && isGoogleAuthorizationUrl(result.value.authorizationUrl)) {
      this.deps.navigate(result.value.authorizationUrl);
      return;
    }
    await remember(false);
    this.setView({ phase: "guest", busy: null });
    this.notify(result.ok ? "login_failed" : noticeFor(result.failure));
  }

  /** Leaves the account: clean copies are removed, unsynced ones stay keyed by account ID. */
  private async leave(
    notice: AccountNotice,
    broadcast: "logged-out" | "deleted" | null,
    removeRecord: boolean,
  ) {
    const view = this.signedIn();
    const session = this.session;
    if (session) this.cancelTimer(session);
    this.session = null;
    const userId = view?.userId ?? session?.userId;
    // Without a loaded session the stored copies were never inspected, so they are kept.
    if (userId && (removeRecord || session !== null)) {
      await this.storage((store) => store.removeAccount(userId, !removeRecord), undefined);
    }
    if (userId && broadcast) this.deps.channel.post({ type: broadcast, userId });
    await this.enterGuest("restore");
    this.notify(notice);
  }

  private async endSession(kind: "logout" | "revoke") {
    const view = this.signedIn();
    if (!view) return;
    this.patchSignedIn({ busy: kind });
    if (this.session?.dirty && view.sync !== "conflict" && view.sync !== "paused") {
      await this.save();
      if (this.signedIn()?.userId !== view.userId) return;
    }
    if (this.session?.dirty) {
      this.patchSignedIn({ busy: null, signOutChoice: kind });
      return;
    }
    await this.signOut(kind, null);
  }

  private async finishSignOut(keepUnsynced: boolean) {
    const kind = this.signedIn()?.signOutChoice;
    if (!kind) return;
    this.patchSignedIn({ signOutChoice: null, busy: kind });
    await this.signOut(kind, keepUnsynced);
  }

  /** `keepUnsynced` is null when no choice was needed; a retry may also have synced meanwhile. */
  private async signOut(kind: "logout" | "revoke", keepUnsynced: boolean | null) {
    const view = this.signedIn();
    if (!view) return;
    const choice = this.session?.dirty ? keepUnsynced : null;
    const result =
      kind === "logout"
        ? await this.deps.api.logout()
        : await this.deps.api.revokeAll(view.userId, { opId: this.deps.newOpId() });
    if (!result.ok && !isHttpFailure(result.failure, 401)) {
      const stale = staleReasonFor(result.failure);
      if (stale) {
        this.markStale(stale);
        return;
      }
      this.patchSignedIn({ busy: null });
      this.notify(noticeFor(result.failure));
      return;
    }
    const plain = kind === "logout" ? "logged_out" : "revoked";
    const notice = choice === null ? plain : choice ? "logged_out_kept" : "logged_out_discarded";
    await this.leave(notice, "logged-out", choice === false);
  }

  private async removeAccount() {
    const view = this.signedIn();
    if (!view) return;
    this.patchSignedIn({ busy: "delete" });
    // A retried deletion reuses its opId so a lost acknowledgement is not a second request.
    this.pendingDeleteOpId ??= this.deps.newOpId();
    const result = await this.deps.api.deleteAccount(view.userId, {
      opId: this.pendingDeleteOpId,
    });
    if (!result.ok) {
      const stale = staleReasonFor(result.failure);
      if (stale) this.markStale(stale);
      else if (isHttpFailure(result.failure, 401)) await this.leave("session_expired", null, false);
      else {
        this.patchSignedIn({ busy: null });
        this.notify(noticeFor(result.failure));
      }
      return;
    }
    this.pendingDeleteOpId = null;
    await this.leave(
      result.value.status === "complete" ? "deleted" : "deletion_pending",
      "deleted",
      true,
    );
  }

  private async downloadExport() {
    if (!this.signedIn()) return;
    this.patchSignedIn({ busy: "export" });
    const result = await this.deps.api.exportData();
    this.patchSignedIn({ busy: null });
    if (!result.ok) {
      if (isHttpFailure(result.failure, 401)) await this.leave("session_expired", null, false);
      else this.notify("export_failed");
      return;
    }
    this.deps.download(
      exportFileName(this.deps.now()),
      `${JSON.stringify(result.value, null, 2)}\n`,
    );
    this.notify("export_ready");
  }

  // ---- consent ----

  private async saveConsent(participation: boolean) {
    const view = this.signedIn();
    if (!view) return;
    const base = view.consent.decisionVersion;
    const pending = this.pendingConsent;
    // Retrying the same decision reuses its opId so an unfinished reservation resumes.
    const op =
      pending?.participation === participation && pending.base === base
        ? pending
        : { participation, base, opId: this.deps.newOpId() };
    this.pendingConsent = op;
    this.patchSignedIn({ busy: "consent" });
    const result = await this.deps.api.putConsent(view.userId, {
      participation,
      baseDecisionVersion: base,
      opId: op.opId,
    });
    if (this.signedIn()?.userId !== view.userId) return;
    if (result.ok) {
      this.pendingConsent = null;
      const known = "participation" in result.value ? result.value : null;
      await this.refreshConsent(view.userId, known, "consent_saved");
      this.deps.channel.post({ type: "consent", userId: view.userId });
      return;
    }
    await this.consentFailure(view.userId, result.failure);
  }

  private async consentFailure(userId: string, failure: ApiFailure) {
    const stale = staleReasonFor(failure);
    if (stale) {
      this.markStale(stale);
      return;
    }
    if (isHttpFailure(failure, 401)) {
      await this.leave("session_expired", null, false);
      return;
    }
    const code = failureCode(failure);
    if (code === "revision_conflict" || code === "op_id_conflict") this.pendingConsent = null;
    if (code === "revision_conflict") {
      await this.refreshConsent(userId, null, "consent_conflict");
      return;
    }
    this.patchSignedIn({ busy: null });
    this.notify(noticeFor(failure));
  }

  private async refreshConsent(
    userId: string,
    known: ConsentGet | null,
    notice: AccountNotice | null,
  ) {
    let consent = known;
    if (!consent) {
      const fresh = await this.deps.api.getConsent();
      if (fresh.ok) consent = fresh.value;
      else if (!notice) notice = noticeFor(fresh.failure);
    }
    if (this.signedIn()?.userId !== userId) return;
    if (consent) {
      this.patchSignedIn({
        consent,
        consentPrompt: consent.participation === null && !this.consentDismissed,
      });
    }
    this.patchSignedIn({ busy: null });
    if (notice) this.notify(notice);
  }
}
