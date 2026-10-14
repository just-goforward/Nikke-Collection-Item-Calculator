import type {
  ConsentGet,
  WorkspaceDocument,
  WorkspacePutResult,
} from "../../personal-data/src/contracts";
import {
  type AccountControllerDeps,
  type AccountNotice,
  type AccountSnapshot,
  type AccountView,
  type ConflictChoice,
  exportFileName,
  isRetryable,
  noticeFor,
  type SignedInView,
  type StaleReason,
  staleReasonFor,
} from "./accountState";
import { type ApiFailure, failureCode, isGoogleAuthorizationUrl, isHttpFailure } from "./api";
import type { CrossTabMessage } from "./crossTab";
import {
  type CalculatorInput,
  calculatorInputKey,
  DEFAULT_CALCULATOR_INPUT,
  EMPTY_WORKSPACE_DOCUMENT,
  readCalculatorInput,
  writeCalculatorInput,
} from "./workspaceDocument";
import type { WorkspaceStore } from "./workspaceStore";

type PendingOp = {
  opId: string;
  key: string;
  baseRevision: number;
  document: WorkspaceDocument;
};

type Session = {
  userId: string;
  /** Latest known server document: source of foreign items and lifetime stages. */
  serverDocument: WorkspaceDocument;
  revision: number;
  syncedKey: string;
  local: CalculatorInput;
  dirty: boolean;
  pendingOp: PendingOp | null;
  conflict: { revision: number; document: WorkspaceDocument } | null;
  retryMs: number;
  cancelTimer: (() => void) | null;
};

const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

function sameIdentity(a: AccountView, b: AccountView): boolean {
  if (a.phase !== b.phase) return false;
  return a.phase !== "signed-in" || (b.phase === "signed-in" && a.userId === b.userId);
}

export class AccountController {
  private snapshot: AccountSnapshot = {
    view: { phase: "loading" },
    notice: null,
    persistent: true,
  };
  private readonly listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private store: WorkspaceStore | null = null;
  private session: Session | null = null;
  private pendingConsent: { participation: boolean; base: number; opId: string } | null = null;
  private pendingDeleteOpId: string | null = null;
  private consentDismissed = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: AccountControllerDeps) {
    this.unsubscribe = deps.channel.subscribe((message) => {
      void this.enqueue(() => this.handleMessage(message));
    });
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

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
  dismissConsentPrompt() {
    this.consentDismissed = true;
    this.patchSignedIn({ consentPrompt: false });
  }
  dismissNotice() {
    this.emit({ ...this.snapshot, notice: null });
  }
  /** Resolves after every operation queued so far has finished. */
  whenIdle() {
    return this.enqueue(async () => undefined);
  }

  /** Called with the calculator's current input after every change. */
  notifyLocalChange(input: CalculatorInput) {
    const session = this.session;
    if (!session || calculatorInputKey(input) === calculatorInputKey(session.local)) return;
    session.local = input;
    session.dirty = calculatorInputKey(input) !== session.syncedKey;
    void this.enqueue(() => this.persistAccount(session));
    const view = this.signedIn();
    if (!view || view.sync === "conflict" || view.sync === "paused" || view.sync === "saving") {
      return;
    }
    if (!session.dirty) {
      this.cancelTimer(session);
      this.patchSignedIn({ sync: "synced" });
      return;
    }
    this.patchSignedIn({ sync: "pending" });
    this.scheduleSave(session, this.deps.saveDelayMs);
  }

  // ---- state plumbing ----

  private emit(next: AccountSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private setView(view: AccountView) {
    this.emit({ ...this.snapshot, view });
  }

  private notify(notice: AccountNotice) {
    this.emit({ ...this.snapshot, notice });
  }

  private signedIn(): SignedInView | null {
    const view = this.snapshot.view;
    return view.phase === "signed-in" ? view : null;
  }

  private patchSignedIn(patch: Partial<Omit<SignedInView, "phase" | "userId">>) {
    const view = this.signedIn();
    if (view) this.setView({ ...view, ...patch });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(async () => {
      if (!this.disposed) await task();
    });
    this.tail = run.catch((error: unknown) => {
      console.error("Account operation failed.", error);
      this.notify("unexpected");
    });
    return this.tail;
  }

  private async ensureStore(): Promise<WorkspaceStore> {
    if (this.store) return this.store;
    const opened = await this.deps.openStore();
    this.store = opened.store;
    if (!opened.persistent) {
      this.emit({ ...this.snapshot, persistent: false, notice: "storage_unavailable" });
    }
    return opened.store;
  }

  /** Device storage refusals degrade to tab-only data with a visible notice; nothing else is hidden. */
  private async storage<T>(action: (store: WorkspaceStore) => Promise<T>, fallback: T): Promise<T> {
    const store = await this.ensureStore();
    try {
      return await action(store);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      this.emit({ ...this.snapshot, persistent: false, notice: "storage_unavailable" });
      return fallback;
    }
  }

  private cancelTimer(session: Session) {
    session.cancelTimer?.();
    session.cancelTimer = null;
  }

  private scheduleSave(session: Session, delayMs: number) {
    this.cancelTimer(session);
    session.cancelTimer = this.deps.schedule(() => {
      session.cancelTimer = null;
      void this.enqueue(() => this.save());
    }, delayMs);
  }

  private applyInput(session: Session, input: CalculatorInput) {
    session.local = input;
    this.deps.calculator.apply(input);
  }

  private async persistAccount(session: Session) {
    if (this.session !== session) return;
    const document = session.dirty
      ? writeCalculatorInput(session.serverDocument, session.local)
      : session.serverDocument;
    await this.storage(
      (store) =>
        store.writeAccount({
          userId: session.userId,
          baseRevision: session.revision,
          document,
          dirty: session.dirty,
          updatedAt: this.deps.now(),
        }),
      undefined,
    );
  }

  private markStale(reason: StaleReason) {
    if (this.session) this.cancelTimer(this.session);
    this.session = null;
    this.setView({ phase: "stale", reason });
  }

  // ---- boot, guest and account entry ----

  private async load() {
    await this.ensureStore();
    const result = await this.deps.api.getAccount();
    if (result.ok) {
      await this.enterAccount(result.value.account.userId, result.value.consent);
      return;
    }
    await this.enterGuest("boot");
    if (!isHttpFailure(result.failure, 401)) this.notify(noticeFor(result.failure));
  }

  /** "boot" restores guest inputs only after an abandoned sign-in; "restore" always does. */
  private async enterGuest(mode: "boot" | "restore") {
    this.session = null;
    const guest = await this.storage((store) => store.readGuest(), null);
    const input = guest ? readCalculatorInput(guest.document) : null;
    if (mode === "restore") this.deps.calculator.apply(input ?? DEFAULT_CALCULATOR_INPUT);
    else if (guest?.restoreOnReturn && input) this.deps.calculator.apply(input);
    if (guest?.restoreOnReturn) {
      await this.storage(
        (store) => store.writeGuest({ ...guest, restoreOnReturn: false }),
        undefined,
      );
    }
    this.setView({ phase: "guest", busy: null });
  }

  private async enterAccount(userId: string, consent: ConsentGet) {
    const [workspace, local, guest] = await Promise.all([
      this.deps.api.getWorkspace(),
      this.storage((store) => store.readAccount(userId), null),
      this.storage((store) => store.readGuest(), null),
    ]);
    if (guest?.restoreOnReturn) {
      await this.storage(
        (store) => store.writeGuest({ ...guest, restoreOnReturn: false }),
        undefined,
      );
    }
    if (!workspace.ok) {
      await this.workspaceUnavailable(userId, consent, workspace.failure);
      return;
    }
    const serverInput = readCalculatorInput(workspace.value.document);
    const session: Session = {
      userId,
      serverDocument: workspace.value.document,
      revision: workspace.value.revision,
      syncedKey: calculatorInputKey(serverInput),
      local: serverInput ?? this.deps.calculator.capture(),
      dirty: false,
      pendingOp: null,
      conflict: null,
      retryMs: 0,
      cancelTimer: null,
    };
    this.session = session;
    this.setView({
      phase: "signed-in",
      userId,
      consent,
      consentPrompt: consent.participation === null && !this.consentDismissed,
      sync: "synced",
      revision: session.revision,
      quota: workspace.value.quota,
      archivingBlocked: workspace.value.quota.newArchivingBlocked,
      conflict: null,
      busy: null,
    });
    this.deps.channel.post({ type: "account", userId });
    await this.reconcile(session, serverInput, local);
  }

  private async workspaceUnavailable(userId: string, consent: ConsentGet, failure: ApiFailure) {
    if (isHttpFailure(failure, 401)) {
      await this.enterGuest("boot");
      return;
    }
    // Signed in, but without a server base revision nothing may be saved; recheck retries entry.
    this.setView({
      phase: "signed-in",
      userId,
      consent,
      consentPrompt: false,
      sync: "error",
      revision: 0,
      quota: null,
      archivingBlocked: false,
      conflict: null,
      busy: null,
    });
    this.notify(noticeFor(failure));
  }

  /** Unsynced edits from an earlier visit survive, but never silently replace newer server data. */
  private async reconcile(
    session: Session,
    serverInput: CalculatorInput | null,
    local: Awaited<ReturnType<WorkspaceStore["readAccount"]>>,
  ) {
    const localInput = local?.dirty ? readCalculatorInput(local.document) : null;
    if (!local || !localInput || calculatorInputKey(localInput) === session.syncedKey) {
      if (serverInput) this.applyInput(session, serverInput);
      await this.persistAccount(session);
      return;
    }
    this.applyInput(session, localInput);
    session.dirty = true;
    await this.persistAccount(session);
    if (local.baseRevision === session.revision) {
      this.patchSignedIn({ sync: "pending" });
      await this.save();
      return;
    }
    this.enterConflict(session, session.revision, session.serverDocument);
  }

  // ---- workspace sync ----

  private async save() {
    const session = this.session;
    const view = this.signedIn();
    if (!session || !view || !session.dirty || view.sync === "conflict" || view.sync === "paused") {
      return;
    }
    this.cancelTimer(session);
    const key = calculatorInputKey(session.local);
    const reusable =
      session.pendingOp?.key === key && session.pendingOp.baseRevision === session.revision;
    const op: PendingOp =
      reusable && session.pendingOp
        ? session.pendingOp
        : {
            opId: this.deps.newOpId(),
            key,
            baseRevision: session.revision,
            document: writeCalculatorInput(session.serverDocument, session.local),
          };
    session.pendingOp = op;
    this.patchSignedIn({ sync: "saving" });
    const result = await this.deps.api.putWorkspace(session.userId, {
      opId: op.opId,
      baseRevision: op.baseRevision,
      document: op.document,
      action: { kind: "save" },
    });
    if (this.session !== session) return;
    if (result.ok) await this.afterPut(session, op, result.value);
    else await this.afterPutFailure(session, result.failure);
  }

  private async afterPut(session: Session, op: PendingOp, result: WorkspacePutResult) {
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
  private async saved(session: Session, op: PendingOp, revision: number) {
    session.pendingOp = null;
    session.retryMs = 0;
    session.serverDocument = op.document;
    session.syncedKey = op.key;
    session.revision = Math.max(session.revision, revision);
    session.dirty = calculatorInputKey(session.local) !== op.key;
    await this.persistAccount(session);
    this.deps.channel.post({
      type: "revision",
      userId: session.userId,
      revision: session.revision,
    });
    this.patchSignedIn({ revision: session.revision, sync: session.dirty ? "pending" : "synced" });
    if (session.dirty) this.scheduleSave(session, this.deps.saveDelayMs);
  }

  private async afterPutFailure(session: Session, failure: ApiFailure) {
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
    this.patchSignedIn({ sync: "error" });
    this.notify(noticeFor(failure));
  }

  private async conflictFromServer(session: Session) {
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
    this.enterConflict(session, fresh.value.revision, fresh.value.document);
  }

  private enterConflict(session: Session, revision: number, document: WorkspaceDocument) {
    const server = readCalculatorInput(document);
    if (calculatorInputKey(server) === calculatorInputKey(session.local)) {
      // Both sides already hold the same inputs: adopt the server revision, nothing to choose.
      session.serverDocument = document;
      session.revision = revision;
      session.syncedKey = calculatorInputKey(server);
      session.dirty = false;
      this.patchSignedIn({ revision, sync: "synced", conflict: null });
      void this.enqueue(() => this.persistAccount(session));
      return;
    }
    session.conflict = { revision, document };
    this.patchSignedIn({
      sync: "conflict",
      conflict: { serverRevision: revision, server, local: session.local },
    });
  }

  private async applyConflictChoice(choice: ConflictChoice) {
    const session = this.session;
    const conflict = session?.conflict;
    if (!session || !conflict) return;
    session.conflict = null;
    if (choice === "cancel") {
      this.patchSignedIn({ sync: "paused", conflict: null });
      return;
    }
    session.serverDocument = conflict.document;
    session.revision = conflict.revision;
    session.pendingOp = null;
    if (choice === "server") {
      const server = readCalculatorInput(conflict.document);
      session.syncedKey = calculatorInputKey(server);
      session.dirty = false;
      this.applyInput(session, server ?? DEFAULT_CALCULATOR_INPUT);
      await this.persistAccount(session);
      this.patchSignedIn({ sync: "synced", conflict: null, revision: session.revision });
      return;
    }
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
    const server = readCalculatorInput(fresh.value.document);
    session.serverDocument = fresh.value.document;
    session.revision = fresh.value.revision;
    session.syncedKey = calculatorInputKey(server);
    if (server) this.applyInput(session, server);
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
    const document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, this.deps.calculator.capture());
    const updatedAt = this.deps.now();
    await this.storage(
      (store) => store.writeGuest({ document, restoreOnReturn: true, updatedAt }),
      undefined,
    );
    const result = await this.deps.api.startLogin();
    if (result.ok && isGoogleAuthorizationUrl(result.value.authorizationUrl)) {
      this.deps.navigate(result.value.authorizationUrl);
      return;
    }
    await this.storage(
      (store) => store.writeGuest({ document, restoreOnReturn: false, updatedAt }),
      undefined,
    );
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
    // Without a loaded session the stored copy was never inspected, so it is kept.
    if (userId && (removeRecord || (session !== null && !session.dirty))) {
      await this.storage((store) => store.deleteAccount(userId), undefined);
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
    await this.leave(kind === "logout" ? "logged_out" : "revoked", "logged-out", false);
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
