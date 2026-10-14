import type { WorkspaceDocument } from "../../personal-data/src/contracts";
import { parseWorkspaceDocument } from "./workspaceDocument";
import type { WorkspaceItemType } from "./workspaceItem";

/**
 * Device-local workspace copies. Guest data and account data live in separate object stores.
 * Account data is kept only while it holds unsynced edits, as one draft per tab and engine keyed
 * by [account ID, draft ID]: tabs never overwrite each other's drafts, one account's draft can
 * never be read as another's or as guest data, and the next tab recovers drafts of closed tabs.
 */
export type GuestRecord = {
  document: WorkspaceDocument;
  /** Set right before leaving for Google sign-in, so a cancelled sign-in restores the inputs. */
  restoreOnReturn: boolean;
  updatedAt: number;
};

export type DraftRecord = {
  userId: string;
  /** The writing tab (see tabIdentity.ts). */
  draftId: string;
  /** Server revision the unsynced edits are based on. */
  baseRevision: number;
  document: WorkspaceDocument;
  updatedAt: number;
};

export type WorkspaceStore = {
  readGuest(): Promise<GuestRecord | null>;
  writeGuest(record: GuestRecord): Promise<void>;
  /** This engine's drafts of the account, newest first. */
  readDrafts(userId: string): Promise<DraftRecord[]>;
  writeDraft(record: DraftRecord): Promise<void>;
  /** Removes the listed drafts of this engine only. */
  removeDrafts(userId: string, draftIds: readonly string[]): Promise<void>;
  /** Removes every engine's drafts of the account (account deletion). */
  removeAccount(userId: string): Promise<void>;
};

const ACCOUNT_DB_NAME = "collection-kit-account";
const ACCOUNT_DB_VERSION = 3;
const GUEST_STORE = "guest-workspace";
const ITEMS: readonly WorkspaceItemType[] = ["calculator-input", "certified-session"];
/** One draft store per item: each engine's base revision and unsynced edits stay its own. */
const DRAFT_STORES: Record<WorkspaceItemType, string> = {
  "calculator-input": "account-drafts",
  "certified-session": "account-certified-drafts",
};
/** Version 2 kept one record per account and engine; its unsynced records become drafts. */
const LEGACY_STORES: Record<WorkspaceItemType, string> = {
  "calculator-input": "account-workspaces",
  "certified-session": "account-certified-sessions",
};
const MIGRATED_DRAFT_ID = "migrated-v2";
const GUEST_KEY = "guest";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseGuestRecord(value: unknown): GuestRecord | null {
  if (!isRecord(value)) return null;
  const document = parseWorkspaceDocument(value["document"]);
  const { restoreOnReturn, updatedAt } = value;
  if (!document || typeof restoreOnReturn !== "boolean" || !isCount(updatedAt)) return null;
  return { document, restoreOnReturn, updatedAt };
}

export function parseDraftRecord(value: unknown, userId: string): DraftRecord | null {
  if (!isRecord(value) || value["userId"] !== userId) return null;
  const document = parseWorkspaceDocument(value["document"]);
  const { draftId, baseRevision, updatedAt } = value;
  if (!document || typeof draftId !== "string" || !isCount(baseRevision) || !isCount(updatedAt)) {
    return null;
  }
  return { userId, draftId, baseRevision, document, updatedAt };
}

function newestFirst(drafts: DraftRecord[]): DraftRecord[] {
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** In-memory device for tests; several stores (engines) may share one device. */
export type MemoryDevice = {
  guest: GuestRecord | null;
  drafts: Map<WorkspaceItemType, Map<string, DraftRecord>>;
};

export function createMemoryDevice(): MemoryDevice {
  return { guest: null, drafts: new Map(ITEMS.map((item) => [item, new Map()])) };
}

export function createMemoryWorkspaceStore(
  item: WorkspaceItemType = "calculator-input",
  device: MemoryDevice = createMemoryDevice(),
): WorkspaceStore {
  const key = (userId: string, draftId: string) => JSON.stringify([userId, draftId]);
  const drafts = (type: WorkspaceItemType) => device.drafts.get(type) ?? new Map();
  return {
    readGuest: async () => (device.guest ? structuredClone(device.guest) : null),
    writeGuest: async (record) => {
      device.guest = structuredClone(record);
    },
    readDrafts: async (userId) =>
      newestFirst(
        [...drafts(item).values()]
          .filter((draft) => draft.userId === userId)
          .map((draft) => structuredClone(draft)),
      ),
    writeDraft: async (record) => {
      drafts(item).set(key(record.userId, record.draftId), structuredClone(record));
    },
    removeDrafts: async (userId, draftIds) => {
      for (const draftId of draftIds) drafts(item).delete(key(userId, draftId));
    },
    removeAccount: async (userId) => {
      for (const type of ITEMS) {
        for (const [entry, draft] of drafts(type)) {
          if (draft.userId === userId) drafts(type).delete(entry);
        }
      }
    },
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new DOMException("IndexedDB request failed.", "UnknownError"));
  });
}

function transact<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  action: (transaction: IDBTransaction) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const result = action(transaction);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Transaction aborted.", "AbortError"));
  });
}

/** Every key of one account: [userId] sorts before [userId, draftId] and arrays after strings. */
function accountRange(userId: string) {
  return IDBKeyRange.bound([userId], [userId, []]);
}

/** Moves version-2 unsynced records into the draft store; synced copies are not needed. */
function migrateLegacy(db: IDBDatabase, transaction: IDBTransaction, item: WorkspaceItemType) {
  const legacy = LEGACY_STORES[item];
  if (!db.objectStoreNames.contains(legacy)) return;
  const drafts = transaction.objectStore(DRAFT_STORES[item]);
  const cursor = transaction.objectStore(legacy).openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) {
      db.deleteObjectStore(legacy);
      return;
    }
    const value: unknown = current.value;
    if (isRecord(value) && value["dirty"] === true && typeof value["userId"] === "string") {
      const { dirty: _dirty, ...record } = value;
      drafts.put({ ...record, draftId: MIGRATED_DRAFT_ID });
    }
    current.continue();
  };
}

function upgrade(request: IDBOpenDBRequest) {
  const db = request.result;
  const transaction = request.transaction;
  if (!transaction) throw new Error("account_store_upgrade_without_transaction");
  if (!db.objectStoreNames.contains(GUEST_STORE)) db.createObjectStore(GUEST_STORE);
  for (const item of ITEMS) {
    if (!db.objectStoreNames.contains(DRAFT_STORES[item])) {
      db.createObjectStore(DRAFT_STORES[item], { keyPath: ["userId", "draftId"] });
    }
    migrateLegacy(db, transaction, item);
  }
}

async function openIndexedDbWorkspaceStore(
  factory: IDBFactory,
  item: WorkspaceItemType,
): Promise<WorkspaceStore> {
  const request = factory.open(ACCOUNT_DB_NAME, ACCOUNT_DB_VERSION);
  request.onupgradeneeded = () => upgrade(request);
  const draftStore = DRAFT_STORES[item];
  const db = await requestResult(request);
  // Let a future schema upgrade in another tab proceed instead of blocking on this connection.
  db.onversionchange = () => db.close();
  return {
    readGuest: async () => {
      const read = await transact(db, GUEST_STORE, "readonly", (transaction) =>
        transaction.objectStore(GUEST_STORE).get(GUEST_KEY),
      );
      return parseGuestRecord(read.result);
    },
    writeGuest: async (record) => {
      await transact(db, GUEST_STORE, "readwrite", (transaction) =>
        transaction.objectStore(GUEST_STORE).put(record, GUEST_KEY),
      );
    },
    readDrafts: async (userId) => {
      const read = await transact(db, draftStore, "readonly", (transaction) =>
        transaction.objectStore(draftStore).getAll(accountRange(userId)),
      );
      const values: unknown[] = read.result;
      return newestFirst(
        values.flatMap((value) => {
          const draft = parseDraftRecord(value, userId);
          return draft ? [draft] : [];
        }),
      );
    },
    writeDraft: async (record) => {
      await transact(db, draftStore, "readwrite", (transaction) =>
        transaction.objectStore(draftStore).put(record),
      );
    },
    removeDrafts: async (userId, draftIds) => {
      await transact(db, draftStore, "readwrite", (transaction) => {
        const store = transaction.objectStore(draftStore);
        for (const draftId of draftIds) store.delete([userId, draftId]);
      });
    },
    removeAccount: async (userId) => {
      const names = ITEMS.map((type) => DRAFT_STORES[type]);
      await transact(db, names, "readwrite", (transaction) => {
        for (const name of names) transaction.objectStore(name).delete(accountRange(userId));
      });
    },
  };
}

/** IndexedDB when the browser allows it; otherwise an in-memory store and `persistent: false`. */
export async function openWorkspaceStore(item: WorkspaceItemType): Promise<{
  store: WorkspaceStore;
  persistent: boolean;
}> {
  try {
    return { store: await openIndexedDbWorkspaceStore(indexedDB, item), persistent: true };
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return { store: createMemoryWorkspaceStore(item), persistent: false };
  }
}
