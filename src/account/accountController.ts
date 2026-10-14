import { type Session, UNKNOWN_BASE_KEY } from "./accountControllerBase";
import {
  type AccountControllerDeps,
  type AccountNotice,
  type AccountView,
  type ConflictChoice,
  exportFileName,
  noticeFor,
  type SignedInView,
  type StaleReason,
  staleReasonFor,
} from "./accountState";
import { AccountSync, nextBackoff } from "./accountSync";
import { type ApiFailure, isGoogleAuthorizationUrl, isHttpFailure } from "./api";
import type { CrossTabMessage } from "./crossTab";
import { EMPTY_WORKSPACE_DOCUMENT } from "./workspaceDocument";

/** What leaving the account removes from this device. */
type DraftRemoval = "keep" | "discard" | "account";

function sameIdentity(a: AccountView, b: AccountView): boolean {
  if (a.phase !== b.phase) return false;
  if (a.phase === "signed-in" || a.phase === "unavailable") {
    return (b.phase === "signed-in" || b.phase === "unavailable") && a.userId === b.userId;
  }
  return true;
}

/** What the account dialogs may call; independent of the engine's item type. */
export type AccountUi = Omit<AccountController<unknown>, "notifyLocalChange">;

export class AccountController<T> extends AccountSync<T> {
  private pendingDeleteOpId: string | null = null;
  /** The page-level account check timed out while loading; a late result must not apply. */
  private bootAbandoned = false;
  /** The one restore of guest inputs saved before a sign-in redirect (boot and timeout share it). */
  private redirectRestore: Promise<void> | null = null;
  /** Retries account entry while the workspace cannot be loaded. */
  private entryRetry: { ms: number; cancel: (() => void) | null } = { ms: 0, cancel: null };
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
    this.cancelEntryRetry();
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
  resolveConflict(choice: ConflictChoice) {
    return this.enqueue(() => this.applyConflictChoice(choice));
  }
  resumeSync() {
    return this.enqueue(() => this.resume());
  }
  /** "Sync now" and the online event; while the account is not loaded, retries entering it. */
  syncNow() {
    if (this.session) this.cancelTimer(this.session);
    return this.enqueue(() =>
      this.snapshot.view.phase === "unavailable" ? this.retryEntry() : this.sync(),
    );
  }
  retryAccount() {
    return this.enqueue(() => this.retryEntry());
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
  /**
   * Page-level timeout: continue with guest data now (not queued behind the hanging check).
   * `restore` brings back inputs saved before a sign-in redirect; it is false once inputs were
   * already released, so no edit made since is replaced. A late sign-in only asks for a reload.
   */
  async bootTimedOut(restore: boolean) {
    if (this.snapshot.view.phase !== "loading") return;
    this.bootAbandoned = true;
    this.setView({ phase: "guest", busy: null });
    this.notify("account_check_timeout");
    if (restore) await this.restoreGuestAfterRedirect();
  }

  protected override markStale(reason: StaleReason) {
    this.cancelEntryRetry();
    super.markStale(reason);
  }

  protected expire() {
    return this.leave("session_expired", null, "keep");
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
      await this.enterAccount(result.value.account.userId, true);
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
    if (mode === "boot") await this.restoreGuestAfterRedirect();
    else await this.showStoredGuest();
    this.setView({ phase: "guest", busy: null });
  }

  /** Shared, so a timeout during the boot's own restore never applies the inputs twice. */
  private restoreGuestAfterRedirect() {
    this.redirectRestore ??= this.restoreRedirectGuest();
    return this.redirectRestore;
  }

  private async restoreRedirectGuest() {
    // Engines with their own guest data already show it; a marker set by the other engine's
    // sign-in in this tab is cleared all the same.
    if (this.deps.calculator.ownGuest) {
      this.deps.markRedirectRestore(false);
      return;
    }
    const guest = await this.storage((store) => store.readGuest(), null);
    if (!guest?.restoreOnReturn) {
      this.deps.markRedirectRestore(false);
      return;
    }
    const value = this.readValue(guest.document);
    if (value !== null) this.deps.calculator.apply(value);
    await this.storage(
      (store) => store.writeGuest({ ...guest, restoreOnReturn: false }),
      undefined,
    );
    this.deps.markRedirectRestore(false);
  }

  private async showStoredGuest() {
    const { calculator, codec } = this.deps;
    if (calculator.ownGuest) {
      calculator.ownGuest.show();
      return;
    }
    const guest = await this.storage((store) => store.readGuest(), null);
    calculator.apply((guest && this.readValue(guest.document)) ?? codec.empty());
    await this.clearRestoreFlag();
  }

  private async readGuestValue(): Promise<T | null> {
    const own = this.deps.calculator.ownGuest;
    if (own) return own.read();
    const guest = await this.storage((store) => store.readGuest(), null);
    return guest ? this.readValue(guest.document) : null;
  }

  /**
   * Keeps guest inputs shown while the account was not loaded as guest data. Called with the value
   * captured in the same synchronous step that hands the inputs to the account (the engine locks
   * them until the switch is shown), so no guest edit falls between the copy and the switch.
   */
  private preserveGuest(value: T) {
    const document = this.deps.codec.write(EMPTY_WORKSPACE_DOCUMENT, value);
    const updatedAt = this.deps.now();
    void this.deviceWrite(() =>
      this.storage(
        (store) => store.writeGuest({ document, restoreOnReturn: false, updatedAt }),
        undefined,
      ),
    );
  }

  /** `boot`: the page-load check, whose result no longer applies once the check timed out. */
  private async enterAccount(userId: string, boot: boolean) {
    const [workspace, drafts, guestValue] = await Promise.all([
      this.deps.api.getWorkspace(userId),
      this.recoverableDrafts(userId),
      this.readGuestValue(),
    ]);
    if (boot && this.bootAbandoned) {
      this.abandonedBootResult(true);
      return;
    }
    if (!workspace.ok) {
      await this.workspaceUnavailable(userId, workspace.failure);
      return;
    }
    this.cancelEntryRetry();
    const { calculator, codec } = this.deps;
    // From the boot check above until the switch is requested nothing awaits: a timeout cannot
    // release the inputs in between, and the guest inputs captured now are exactly those the
    // account data replaces.
    const shown = calculator.ownGuest ? null : calculator.capture();
    if (shown !== null && this.snapshot.view.phase === "unavailable") this.preserveGuest(shown);
    const server = codec.read(workspace.value.document);
    const offerGuest =
      server.status === "absent" && guestValue !== null && !codec.isEmpty(guestValue);
    let initial: T;
    if (server.status === "value") initial = server.value;
    // Engines with their own guest data must not show it as this account's data.
    else initial = shown ?? codec.empty();
    const session: Session<T> = {
      userId,
      serverDocument: workspace.value.document,
      revision: workspace.value.revision,
      syncedKey: this.itemKey(server) ?? UNKNOWN_BASE_KEY,
      local: initial,
      dirty: false,
      pendingOp: null,
      unacked: [],
      announcedRevision: workspace.value.revision,
      conflict: null,
      serverUnreadable: server.status === "unreadable",
      guestOffer:
        offerGuest && guestValue !== null
          ? { value: guestValue, summary: codec.summary(guestValue) }
          : null,
      retryMs: 0,
      cancelTimer: null,
      recovering: drafts,
      closed: false,
    };
    this.session = session;
    this.setView(
      this.signedInView(userId, {
        revision: session.revision,
        quota: workspace.value.quota,
        archivingBlocked: workspace.value.quota.newArchivingBlocked,
        itemBytes: codec.bytes(initial),
      }),
    );
    this.deps.channel.post({ type: "account", userId });
    // The redirect's guest inputs stay stored as guest data; they need no restore any more. Only
    // after the switch: a timeout firing now finds the check settled and changes nothing.
    await this.clearRestoreFlag();
    await this.reconcile(session, server.status === "value");
  }

  private async clearRestoreFlag() {
    if (this.deps.calculator.ownGuest) {
      this.deps.markRedirectRestore(false);
      return;
    }
    const guest = await this.storage((store) => store.readGuest(), null);
    if (guest?.restoreOnReturn) {
      await this.storage(
        (store) => store.writeGuest({ ...guest, restoreOnReturn: false }),
        undefined,
      );
    }
    this.deps.markRedirectRestore(false);
  }

  /**
   * Signed in, but without the workspace nothing can be shown or saved: guest data stays shown,
   * clearly marked as "account not loaded", while entry is retried with backoff and on `online`.
   */
  private async workspaceUnavailable(userId: string, failure: ApiFailure) {
    const stale = staleReasonFor(failure);
    if (stale) {
      this.markStale(stale);
      return;
    }
    if (this.snapshot.view.phase === "loading" || isHttpFailure(failure, 401)) {
      await this.enterGuest("boot");
      // The boot has settled on guest data; a timeout during it leaves nothing late to apply.
      this.bootAbandoned = false;
    }
    if (isHttpFailure(failure, 401)) {
      this.cancelEntryRetry();
      return;
    }
    this.setView({ phase: "unavailable", userId });
    this.notify("account_unavailable");
    this.scheduleEntryRetry();
  }

  private scheduleEntryRetry() {
    this.entryRetry.cancel?.();
    this.entryRetry.ms = nextBackoff(this.entryRetry.ms);
    this.entryRetry.cancel = this.deps.schedule(() => {
      this.entryRetry.cancel = null;
      void this.enqueue(() => this.retryEntry());
    }, this.entryRetry.ms);
  }

  private cancelEntryRetry() {
    this.entryRetry.cancel?.();
    this.entryRetry = { ms: 0, cancel: null };
  }

  private async retryEntry() {
    const view = this.snapshot.view;
    if (view.phase !== "unavailable") return;
    this.entryRetry.cancel?.();
    this.entryRetry.cancel = null;
    // Guest edits made meanwhile are kept as guest data at the switch (see `enterAccount`).
    const result = await this.deps.api.getAccount();
    if (this.snapshot.view !== view) return;
    if (!result.ok) {
      if (!isHttpFailure(result.failure, 401)) {
        this.scheduleEntryRetry();
        return;
      }
      this.cancelEntryRetry();
      this.setView({ phase: "guest", busy: null });
      this.notify("session_expired");
      return;
    }
    if (result.value.account.userId !== view.userId) {
      this.markStale("account_changed");
      return;
    }
    await this.enterAccount(view.userId, false);
  }

  private signedInView(
    userId: string,
    fields: Partial<Omit<SignedInView, "phase" | "userId">>,
  ): SignedInView {
    return {
      phase: "signed-in",
      userId,
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
    void this.persist(session);
    this.patchSignedIn({ sync: "pending" });
    this.notify("guest_imported");
    await this.save();
  }

  /** Shows the account data, then recovers unsynced drafts; none silently replaces server data. */
  private async reconcile(session: Session<T>, serverHasValue: boolean) {
    if (serverHasValue || this.deps.calculator.ownGuest) this.applyInput(session, session.local);
    await this.recoverNext(session);
    if (this.session !== session || session.dirty) return;
    void this.persist(session);
    if (session.serverUnreadable && session.conflict === null) {
      this.enterConflict(session, session.revision, session.serverDocument, false);
    }
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
    await this.ownAccountMessage(view.phase === "unavailable", message);
  }

  private async ownAccountMessage(unavailable: boolean, message: CrossTabMessage): Promise<void> {
    if (message.type === "logged-out") return this.leave("logged_out_elsewhere", null, "keep");
    if (message.type === "deleted") return this.leave("deleted", null, "account");
    // Another tab reached the server: try entering the account again.
    if (unavailable) return this.retryEntry();
    if (message.type === "revision") return this.remoteRevision(message.revision);
  }

  /** Detects sign-in changes that happened while this tab was hidden or its broadcast was missed. */
  private async recheck() {
    const view = this.snapshot.view;
    if (view.phase === "loading" || view.phase === "stale") return;
    if (view.phase === "guest" && view.busy === "login") return;
    if (view.phase === "unavailable") {
      await this.retryEntry();
      return;
    }
    const result = await this.deps.api.getAccount();
    if (!sameIdentity(view, this.snapshot.view)) return;
    if (view.phase === "guest") {
      if (result.ok) this.markStale("signed_in_elsewhere");
      return;
    }
    if (!result.ok) {
      if (isHttpFailure(result.failure, 401))
        await this.leave("logged_out_elsewhere", null, "keep");
      return;
    }
    if (result.value.account.userId !== view.userId) {
      this.markStale("account_changed");
    }
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
    const remember = async (restoreOnReturn: boolean) => {
      if (!document) return;
      await this.storage(
        (store) => store.writeGuest({ document, restoreOnReturn, updatedAt }),
        undefined,
      );
      this.deps.markRedirectRestore(restoreOnReturn);
    };
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

  /**
   * Leaves the account for guest data. The latest edits reach the device first; unsynced drafts
   * are kept unless the user chose to discard them (this engine only) or the account is deleted.
   */
  private async leave(
    notice: AccountNotice,
    broadcast: "logged-out" | "deleted" | null,
    removal: DraftRemoval,
  ) {
    const view = this.snapshot.view;
    const session = this.session;
    if (session) this.cancelTimer(session);
    this.cancelEntryRetry();
    this.session = null;
    const userId =
      view.phase === "signed-in" || view.phase === "unavailable" ? view.userId : session?.userId;
    await this.flushPersist();
    if (session) session.closed = true;
    if (userId && removal === "account") {
      await this.storage((store) => store.removeAccount(userId), undefined);
    } else if (userId && removal === "discard") {
      // Only what the prompt covered: this tab's edits, including drafts it adopted and showed.
      // Closed tabs' drafts it has not shown yet stay for the next sign-in.
      await this.storage((store) => store.removeDrafts(userId, [this.deps.tab.id]), undefined);
    }
    if (userId && broadcast) this.deps.channel.post({ type: broadcast, userId });
    // While the account was not loaded, guest data is what is shown already.
    if (view.phase === "unavailable") this.setView({ phase: "guest", busy: null });
    else await this.enterGuest("restore");
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
    await this.leave(notice, "logged-out", choice === false ? "discard" : "keep");
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
      await this.privateFailure(result.failure, () => {
        this.patchSignedIn({ busy: null });
        this.notify(noticeFor(result.failure));
      });
      return;
    }
    this.pendingDeleteOpId = null;
    await this.leave(
      result.value.status === "complete" ? "deleted" : "deletion_pending",
      "deleted",
      "account",
    );
  }

  /** Stale context stops the tab, 401 leaves for guest data, anything else is reported. */
  private async privateFailure(failure: ApiFailure, otherwise: () => void) {
    const stale = staleReasonFor(failure);
    if (stale) this.markStale(stale);
    else if (isHttpFailure(failure, 401)) await this.expire();
    else otherwise();
  }

  /** The export is verified to belong to the shown account before any download is created. */
  private async downloadExport() {
    const view = this.signedIn();
    if (!view) return;
    this.patchSignedIn({ busy: "export" });
    const result = await this.deps.api.exportData(view.userId);
    if (this.signedIn()?.userId !== view.userId) return;
    this.patchSignedIn({ busy: null });
    if (!result.ok) {
      await this.privateFailure(result.failure, () => this.notify("export_failed"));
      return;
    }
    this.deps.download(
      exportFileName(this.deps.now()),
      `${JSON.stringify(result.value, null, 2)}\n`,
    );
    this.notify("export_ready");
  }
}
