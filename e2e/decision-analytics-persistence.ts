export type PersistenceCall = {
  area: "local" | "session" | "cookie" | "indexedDB";
  operation: string;
  key: string;
  denied: boolean;
};
export type PersonalInventory = {
  local: Record<string, string>;
  session: Record<string, string>;
  cookie: string;
  database: { version: number; stores: Record<string, unknown[]> } | null;
  publicCache: string | null;
};
export type PersistenceApi = {
  configure(denied: boolean): void;
  seed(asOf: string): Promise<PersonalInventory>;
  inventory(database?: boolean): Promise<PersonalInventory>;
  evidence(): { calls: PersistenceCall[]; forbidden: PersistenceCall[] };
};
declare global {
  interface Window { decisionPersistence: PersistenceApi; }
}

// Serialized by addInitScript: all runtime dependencies stay inside this function.
export function installPersistenceAudit() {
  const raw = { local: window.localStorage, session: window.sessionStorage };
  const native = {
    get: Storage.prototype.getItem,
    set: Storage.prototype.setItem,
    remove: Storage.prototype.removeItem,
    key: Storage.prototype.key,
  };
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  const factory = window.indexedDB;
  const open = factory.open.bind(factory);
  const publicCaches = window.caches;
  const calls: PersistenceCall[] = [];
  let denied = false;
  const accountStores = [
    "guest-workspace", "account-drafts", "account-certified-drafts",
    "account-workspaces", "account-certified-sessions",
  ];
  const cacheName = "decision-analytics-public-fixture";
  const cacheUrl = new URL("/public-fixture-forecast.json", location.origin).href;
  const allowed = (call: PersistenceCall) => call.area === "local" &&
    call.key === "collectionThemeMode" && ["getItem", "setItem", "removeItem"].includes(call.operation);
  const record = (area: PersistenceCall["area"], operation: string, key: string) => {
    calls.push({ area, operation, key, denied });
    if (denied) throw new DOMException("Synthetic storage denial", "SecurityError");
  };
  for (const area of ["local", "session"] as const) {
    const store = raw[area];
    const proxy = new Proxy(store, {
      get(target, key) {
        if (key === "getItem") return (name: string) => {
          record(area, "getItem", String(name));
          return native.get.call(store, name);
        };
        if (key === "setItem") return (name: string, value: string) => {
          record(area, "setItem", String(name));
          return native.set.call(store, name, value);
        };
        if (key === "removeItem") return (name: string) => {
          record(area, "removeItem", String(name));
          return native.remove.call(store, name);
        };
        if (key === "clear") return () => {
          record(area, "clear", "*");
          throw new Error("Personal storage must never be cleared");
        };
        if (key === "key") return (index: number) => {
          record(area, "key", String(index));
          return native.key.call(store, index);
        };
        if (key === "length") {
          record(area, "length", "*");
          return store.length;
        }
        if (typeof key === "symbol" || ["constructor", "toString", "valueOf"].includes(key))
          return Reflect.get(target, key, target);
        record(area, "property-get", key);
        return native.get.call(store, key) ?? undefined;
      },
      set(_target, key, value) {
        record(area, "property-set", String(key));
        native.set.call(store, String(key), String(value));
        return true;
      },
      deleteProperty(_target, key) {
        record(area, "property-delete", String(key));
        native.remove.call(store, String(key));
        return true;
      },
      defineProperty(target, key, descriptor) {
        record(area, "defineProperty", String(key));
        return Reflect.defineProperty(target, key, descriptor);
      },
      ownKeys(target) {
        record(area, "ownKeys", "*");
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        record(area, "descriptor", String(key));
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    Object.defineProperty(window, area === "local" ? "localStorage" : "sessionStorage", {
      configurable: true, get: () => proxy,
    });
  }
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() { record("cookie", "get", "*"); return cookie.get!.call(document); },
    set(value: string) { record("cookie", "set", "*"); cookie.set!.call(document, value); },
  });
  factory.open = () => { record("indexedDB", "open", "*"); throw new Error("App IndexedDB open prohibited"); };
  factory.deleteDatabase = () => { record("indexedDB", "deleteDatabase", "*"); throw new Error("App IndexedDB deletion prohibited"); };
  factory.databases = async () => { record("indexedDB", "databases", "*"); throw new Error("App IndexedDB enumeration prohibited"); };

  const database = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = open("collection-kit-account", 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("guest-workspace");
      request.result.createObjectStore("account-drafts", { keyPath: ["userId", "draftId"] });
      request.result.createObjectStore("account-certified-drafts", { keyPath: ["userId", "draftId"] });
      request.result.createObjectStore("account-workspaces", { keyPath: "userId" });
      request.result.createObjectStore("account-certified-sessions", { keyPath: "userId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const storageInventory = (store: Storage) => {
    const result: Record<string, string> = {};
    for (let index = 0; index < store.length; ++index) {
      const key = native.key.call(store, index)!;
      result[key] = native.get.call(store, key)!;
    }
    return result;
  };
  window.decisionPersistence = {
    configure(value) { denied = value; },
    async seed(asOf) {
      const now = Date.parse(asOf);
      const envelope = { eventId: "TEST-ONLY-old-event", sourceHost: "direct", event: { kind: "kit_result" } };
      for (const endpoint of [
        "https://collection-kit-stats.tbvj159.workers.dev", "https://nikkecollection.com",
        "https://collection-kit-stats-staging.tbvj159.workers.dev", "https://staging.nikkecollection.com",
      ]) {
        for (const version of [1, 2]) {
          const record = { envelope, expiresAt: now + 60_000,
            ...(version === 2 ? { queuedAt: now - 1000, attempts: 1, lastFailureClass: "network" } : {}) };
          native.set.call(raw.local,
            `collection-kit-calculator.stats-outbox.v${version}:${encodeURIComponent(endpoint)}`,
            JSON.stringify({ version, records: [record] }));
        }
        native.set.call(raw.local,
          `collection-kit-calculator.stats-delivery-health.v1:${encodeURIComponent(endpoint)}`,
          "TEST-ONLY-malformed-retained-health");
      }
      native.set.call(raw.local, "collectionThemeMode", "light");
      native.set.call(raw.session, "nikke:legacy-reload-input:v1", JSON.stringify({
        schema: 1, revision: "legacy-input-v1", savedAt: now, url: location.href,
        input: { grade: "SR", level: 7, exp: 100, stock: { blue: 777, purple: 666, yellow: 555 } },
      }));
      native.set.call(raw.session, "collection-kit-account:restore-pending", "1");
      cookie.set!.call(document, "TEST_ONLY_OLD_COOKIE=retained; Path=/; SameSite=Strict");
      const db = await database();
      try {
        const transaction = db.transaction(accountStores, "readwrite");
        const complete = new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        const document = { schemaVersion: 1, items: [{
          type: "calculator-input", version: 1,
          input: { grade: "SR", level: 7, exp: 100, stock: { blue: 777, purple: 666, yellow: 555 } },
        }], lifetimeStages: [] };
        transaction.objectStore("guest-workspace").put({ document, restoreOnReturn: true, updatedAt: now }, "guest");
        for (const name of accountStores.slice(1)) transaction.objectStore(name).put({
          userId: "TEST_ONLY_OLD_USER", draftId: "TEST_ONLY_OLD_DRAFT", document,
          baseRevision: 3, baseKey: null, updatedAt: now,
        });
        await complete;
      } finally { db.close(); }
      const cache = await publicCaches.open(cacheName);
      await cache.put(cacheUrl, new Response("TEST-ONLY-PUBLIC-CACHE-SENTINEL"));
      return window.decisionPersistence.inventory(true);
    },
    async inventory(includeDatabase = false) {
      let storedDatabase: PersonalInventory["database"] = null;
      if (includeDatabase) {
        const db = await database();
        try {
          const transaction = db.transaction(accountStores, "readonly");
          const rows = await Promise.all(accountStores.map((name) => new Promise<[string, unknown[]]>((resolve, reject) => {
            const request = transaction.objectStore(name).getAll();
            request.onsuccess = () => resolve([name, request.result]);
            request.onerror = () => reject(request.error);
          })));
          storedDatabase = { version: db.version, stores: Object.fromEntries(rows) };
        } finally { db.close(); }
      }
      const cache = await publicCaches.has(cacheName) ? await publicCaches.open(cacheName) : null;
      const cached = await cache?.match(cacheUrl);
      return {
        local: storageInventory(raw.local), session: storageInventory(raw.session),
        cookie: cookie.get!.call(document), database: storedDatabase,
        publicCache: cached ? await cached.text() : null,
      };
    },
    evidence() {
      return { calls: structuredClone(calls), forbidden: structuredClone(calls.filter((call) => !allowed(call))) };
    },
  };
}
