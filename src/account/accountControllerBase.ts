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
import type { WorkspaceStore } from "./workspaceStore";

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
  conflict: { revision: number; document: WorkspaceDocument } | null;
  /** The server copy failed validation: never applied; only an explicit overwrite replaces it. */
  serverUnreadable: boolean;
  /** Guest data that may be copied in explicitly while the account has none of its own. */
  guestOffer: { value: T; summary: CalculatorInput } | null;
  retryMs: number;
  cancelTimer: (() => void) | null;
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
  private store: WorkspaceStore | null = null;

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
  /** Resolves after every operation queued so far has finished. */
  whenIdle() {
    return this.enqueue(async () => undefined);
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

  protected async ensureStore(): Promise<WorkspaceStore> {
    if (this.store) return this.store;
    const opened = await this.deps.openStore();
    this.store = opened.store;
    if (!opened.persistent) {
      this.emit({ ...this.snapshot, persistent: false, notice: "storage_unavailable" });
    }
    return opened.store;
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

  protected async persistAccount(session: Session<T>) {
    if (this.session !== session) return;
    const document = session.dirty
      ? this.deps.codec.write(session.serverDocument, session.local)
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

  protected markStale(reason: StaleReason) {
    if (this.session) this.cancelTimer(this.session);
    this.session = null;
    this.setView({ phase: "stale", reason });
  }
}
