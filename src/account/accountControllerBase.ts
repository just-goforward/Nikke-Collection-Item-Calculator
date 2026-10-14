import type { WorkspaceDocument } from "../../personal-data/src/contracts";
import type {
  AccountControllerDeps,
  AccountNotice,
  AccountSnapshot,
  AccountView,
  SignedInView,
  StaleReason,
} from "./accountState";
import type { CalculatorInput } from "./workspaceDocument";
import type { ItemRead } from "./workspaceItem";
import type { DraftRecord, WorkspaceStore } from "./workspaceStore";

export type PendingOp = {
  opId: string;
  key: string;
  baseRevision: number;
  document: WorkspaceDocument;
};

/** Key of the item in a revision without one. */
const NO_ITEM_KEY = "none";
/** Key for a base the client cannot vouch for (unreadable, or edits from an older revision). */
export const UNKNOWN_BASE_KEY = "unknown-base";

export type Session<T> = {
  userId: string;
  /** Latest known server document: source of foreign items and lifetime stages. */
  serverDocument: WorkspaceDocument;
  revision: number;
  /** Key of this item in the revision the local edits are based on. */
  syncedKey: string;
  local: T;
  dirty: boolean;
  pendingOp: PendingOp | null;
  /** Sent operations without an answer: a matching `lastOpId` acknowledges one after a loss. */
  unacked: PendingOp[];
  /** Highest server revision announced by other tabs or conflict answers. */
  announcedRevision: number;
  conflict: { revision: number; document: WorkspaceDocument } | null;
  /** The server copy failed validation: never applied; only an explicit overwrite replaces it. */
  serverUnreadable: boolean;
  /** Guest data that may be copied in explicitly while the account has none of its own. */
  guestOffer: { value: T; summary: CalculatorInput } | null;
  retryMs: number;
  cancelTimer: (() => void) | null;
  /** This tab's earlier and closed tabs' drafts, recovered one at a time once settled. */
  recovering: DraftRecord[];
  /** Set once the session was left: queued device writes for it no longer run. */
  closed: boolean;
};

/** Signed-in fields the controller derives itself instead of accepting through a patch. */
type DerivedField = "phase" | "userId" | "guestImport";

/** State, queue, timer and device-storage plumbing shared by the account controller. */
export abstract class AccountControllerBase<T> {
  protected snapshot: AccountSnapshot = {
    view: { phase: "loading" },
    notice: null,
    persistent: true,
  };
  protected session: Session<T> | null = null;
  protected disposed = false;
  private readonly listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  /** Device writes have their own queue: no request in flight can delay them. */
  private persistTail: Promise<void> = Promise.resolve();
  private storeReady: Promise<WorkspaceStore> | null = null;

  constructor(protected readonly deps: AccountControllerDeps<T>) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  dismissNotice() {
    this.emit({ ...this.snapshot, notice: null });
  }
  /** Shows a notice after the operations queued so far (e.g. a login error from the URL). */
  showNotice(notice: AccountNotice) {
    return this.enqueue(async () => this.notify(notice));
  }
  /** Resolves after every operation and device write queued so far has finished. */
  async whenIdle() {
    await this.enqueue(async () => undefined);
    await this.persistTail;
  }

  protected abstract save(): Promise<void>;

  protected emit(next: AccountSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  protected setView(view: AccountView) {
    this.emit({ ...this.snapshot, view });
  }

  protected notify(notice: AccountNotice) {
    this.emit({ ...this.snapshot, notice });
  }

  protected signedIn(): SignedInView | null {
    const view = this.snapshot.view;
    return view.phase === "signed-in" ? view : null;
  }

  /** The copy offer only exists while the account still has no item of its own. */
  protected guestImport(): CalculatorInput | null {
    const session = this.session;
    return session?.guestOffer && session.syncedKey === NO_ITEM_KEY
      ? session.guestOffer.summary
      : null;
  }

  /** Server item identity; null for an unreadable item, which matches nothing. */
  protected itemKey(read: ItemRead<T>): string | null {
    if (read.status === "absent") return NO_ITEM_KEY;
    return read.status === "value" ? this.deps.codec.key(read.value) : null;
  }

  protected patchSignedIn(patch: Partial<Omit<SignedInView, DerivedField>>) {
    const view = this.signedIn();
    if (view) this.setView({ ...view, ...patch, guestImport: this.guestImport() });
  }

  protected enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(async () => {
      if (!this.disposed) await task();
    });
    this.tail = run.catch((error: unknown) => {
      console.error("Account operation failed.", error);
      this.notify("unexpected");
    });
    return this.tail;
  }

  protected ensureStore(): Promise<WorkspaceStore> {
    this.storeReady ??= this.deps
      .openStore(() => this.notify("storage_blocked"))
      .then((opened) => {
        if (!opened.persistent) {
          this.emit({ ...this.snapshot, persistent: false, notice: "storage_unavailable" });
        }
        return opened.store;
      });
    return this.storeReady;
  }

  /** Device storage refusals degrade to tab-only data with a visible notice; nothing else is hidden. */
  protected async storage<T>(
    action: (store: WorkspaceStore) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const store = await this.ensureStore();
    try {
      return await action(store);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      this.emit({ ...this.snapshot, persistent: false, notice: "storage_unavailable" });
      return fallback;
    }
  }

  protected cancelTimer(session: Session<T>) {
    session.cancelTimer?.();
    session.cancelTimer = null;
  }

  protected scheduleSave(session: Session<T>, delayMs: number) {
    this.cancelTimer(session);
    session.cancelTimer = this.deps.schedule(() => {
      session.cancelTimer = null;
      void this.enqueue(() => this.save());
    }, delayMs);
  }

  protected applyInput(session: Session<T>, value: T) {
    session.local = value;
    this.deps.calculator.apply(value);
    if (this.session === session) this.patchSignedIn({ itemBytes: this.deps.codec.bytes(value) });
  }

  /**
   * Queues a device write of the session's state at the time it runs, so the latest edit always
   * wins. It also runs after the session lost ownership (401, stale) unless the session was left.
   * Unsynced edits are this tab's draft; a synced session keeps no device copy.
   */
  protected persist(session: Session<T>): Promise<void> {
    return this.deviceWrite(() => this.writeDraft(session)).then(() => undefined);
  }

  /** Runs a device write after every device write queued so far; its failures are reported. */
  protected deviceWrite<R>(task: () => Promise<R>): Promise<R | undefined> {
    const run = this.persistTail.then(task);
    this.persistTail = run.then(
      () => undefined,
      (error: unknown) => {
        console.error("Account device write failed.", error);
        this.notify("unexpected");
      },
    );
    return run.catch(() => undefined);
  }

  /**
   * Adopts another draft as this tab's draft in one atomic device step (see `claimDraft` in
   * workspaceStore.ts), queued with this tab's other device writes. "failed": the device refused
   * the write and the source draft is untouched; the refusal is reported. "busy": `intervened`
   * reported an edit (or a left session) while claiming; the draft is moved back, again in one
   * atomic step, before the edit's own queued write replaces this tab's draft.
   */
  protected async claimDraft(
    source: DraftRecord,
    record: DraftRecord,
    intervened: () => boolean,
  ): Promise<"claimed" | "gone" | "busy" | "failed"> {
    const outcome = await this.deviceWrite(() =>
      this.storage(async (store) => {
        if (intervened()) return "busy" as const;
        if (!(await store.claimDraft(record.userId, source.draftId, record)))
          return "gone" as const;
        if (!intervened()) return "claimed" as const;
        await store.claimDraft(record.userId, record.draftId, source);
        return "busy" as const;
      }, "failed" as const),
    );
    return outcome ?? "failed";
  }

  /** This tab's draft of the session's unsynced edits. */
  protected draftRecord(session: Session<T>): DraftRecord {
    return {
      userId: session.userId,
      draftId: this.deps.tab.id,
      baseRevision: session.revision,
      baseKey: session.syncedKey === UNKNOWN_BASE_KEY ? null : session.syncedKey,
      document: this.deps.codec.write(session.serverDocument, session.local),
      updatedAt: this.deps.now(),
    };
  }

  /** Resolves after every device write queued so far. */
  protected flushPersist(): Promise<void> {
    return this.persistTail;
  }

  private async writeDraft(session: Session<T>) {
    if (session.closed) return;
    const { tab } = this.deps;
    if (!session.dirty) {
      await this.storage((store) => store.removeDrafts(session.userId, [tab.id]), undefined);
      return;
    }
    const record = this.draftRecord(session);
    await this.storage((store) => store.writeDraft(record), undefined);
  }

  protected readValue(document: WorkspaceDocument): T | null {
    const read = this.deps.codec.read(document);
    return read.status === "value" ? read.value : null;
  }

  protected markStale(reason: StaleReason) {
    if (this.session) this.cancelTimer(this.session);
    this.session = null;
    this.setView({ phase: "stale", reason });
  }
}
