import type { WorkspaceDocument } from "../../personal-data/src/contracts";
import { parseWorkspaceDocument } from "./workspaceDocument";
import type { WorkspaceItemType } from "./workspaceItem";

/**
 * Device-local workspace copies. Guest data and account data live in separate object stores;
 * account records are keyed by account ID, so one account's copy can never be read as another's
 * or as guest data.
 */
export type GuestRecord = {
  document: WorkspaceDocument;
  /** Set right before leaving for Google sign-in, so a cancelled sign-in restores the inputs. */
  restoreOnReturn: boolean;
  updatedAt: number;
};

export type AccountRecord = {
  userId: string;
  baseRevision: number;
  document: WorkspaceDocument;
  /** True when this device holds edits the server has not acknowledged. */
  dirty: boolean;
  updatedAt: number;
};

export type WorkspaceStore = {
  readGuest(): Promise<GuestRecord | null>;
  writeGuest(record: GuestRecord): Promise<void>;
  readAccount(userId: string): Promise<AccountRecord | null>;
  writeAccount(record: AccountRecord): Promise<void>;
  /** Removes this account's copies of every item; `keepUnsynced` keeps copies with unsynced edits. */
  removeAccount(userId: string, keepUnsynced: boolean): Promise<void>;
};

const ACCOUNT_DB_NAME = "collection-kit-account";
const ACCOUNT_DB_VERSION = 2;
const GUEST_STORE = "guest-workspace";
/** One account store per item: each engine's unsynced flag and base revision stay its own. */
const ACCOUNT_STORES: Record<WorkspaceItemType, string> = {
  "calculator-input": "account-workspaces",
  "certified-session": "account-certified-sessions",
};
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

export function parseAccountRecord(value: unknown, userId: string): AccountRecord | null {
  if (!isRecord(value) || value["userId"] !== userId) return null;
  const document = parseWorkspaceDocument(value["document"]);
  const { baseRevision, dirty, updatedAt } = value;
  if (!document || !isCount(baseRevision) || typeof dirty !== "boolean" || !isCount(updatedAt)) {
    return null;
  }
  return { userId, baseRevision, document, dirty, updatedAt };
}

export function createMemoryWorkspaceStore(): WorkspaceStore {
  let guest: GuestRecord | null = null;
  const accounts = new Map<string, AccountRecord>();
  return {
    readGuest: async () => (guest ? structuredClone(guest) : null),
    writeGuest: async (record) => {
      guest = structuredClone(record);
    },
    readAccount: async (userId) => {
      const record = accounts.get(userId);
      return record ? structuredClone(record) : null;
    },
    writeAccount: async (record) => {
      accounts.set(record.userId, structuredClone(record));
    },
    removeAccount: async (userId, keepUnsynced) => {
      if (!keepUnsynced || !accounts.get(userId)?.dirty) accounts.delete(userId);
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
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Transaction aborted.", "AbortError"));
  });
}

function removeAccountCopies(db: IDBDatabase, userId: string, keepUnsynced: boolean) {
  return new Promise<void>((resolve, reject) => {
    const names = Object.values(ACCOUNT_STORES);
    const transaction = db.transaction(names, "readwrite");
    for (const name of names) {
      const store = transaction.objectStore(name);
      if (!keepUnsynced) {
        store.delete(userId);
        continue;
      }
      const request = store.get(userId);
      request.onsuccess = () => {
        const value: unknown = request.result;
        if (!isRecord(value) || value["dirty"] !== true) store.delete(userId);
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException("Transaction aborted.", "AbortError"));
  });
}

async function openIndexedDbWorkspaceStore(
  factory: IDBFactory,
  item: WorkspaceItemType,
): Promise<WorkspaceStore> {
  const request = factory.open(ACCOUNT_DB_NAME, ACCOUNT_DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(GUEST_STORE)) db.createObjectStore(GUEST_STORE);
    for (const name of Object.values(ACCOUNT_STORES)) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "userId" });
    }
  };
  const accountStore = ACCOUNT_STORES[item];
  const db = await requestResult(request);
  // Let a future schema upgrade in another tab proceed instead of blocking on this connection.
  db.onversionchange = () => db.close();
  return {
    readGuest: async () =>
      parseGuestRecord(
        await transact(db, GUEST_STORE, "readonly", (store) => store.get(GUEST_KEY)),
      ),
    writeGuest: async (record) => {
      await transact(db, GUEST_STORE, "readwrite", (store) => store.put(record, GUEST_KEY));
    },
    readAccount: async (userId) =>
      parseAccountRecord(
        await transact(db, accountStore, "readonly", (store) => store.get(userId)),
        userId,
      ),
    writeAccount: async (record) => {
      await transact(db, accountStore, "readwrite", (store) => store.put(record));
    },
    removeAccount: (userId, keepUnsynced) => removeAccountCopies(db, userId, keepUnsynced),
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
    return { store: createMemoryWorkspaceStore(), persistent: false };
  }
}
