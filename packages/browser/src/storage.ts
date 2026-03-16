import type { PersistentQueue, QueuedRecord } from "./types";

type StoreRecord<T> = {
  id?: number;
  value: T;
};

type MemoryStore<T> = {
  nextId: number;
  values: Array<Required<StoreRecord<T>>>;
};

const memoryStores = new Map<string, MemoryStore<unknown>>();

function getMemoryStore<T>(storeKey: string): MemoryStore<T> {
  const existing = memoryStores.get(storeKey);
  if (existing) {
    return existing as MemoryStore<T>;
  }

  const created: MemoryStore<T> = {
    nextId: 1,
    values: [],
  };
  memoryStores.set(storeKey, created as MemoryStore<unknown>);
  return created;
}

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to open IndexedDB ${dbName}`));
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, {
          autoIncrement: true,
        });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        reject(new Error(`Missing object store ${storeName}`));
        return;
      }
      resolve(db);
    };
  });
}

function withObjectStore<T>(
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return openDb(dbName, storeName).then(async (db) => {
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = await run(store);

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      });

      return result;
    } finally {
      db.close();
    }
  });
}

function unwrapStoredValue<T>(stored: unknown): T {
  if (
    stored !== null &&
    typeof stored === "object" &&
    "value" in (stored as Record<string, unknown>)
  ) {
    return (stored as StoreRecord<T>).value;
  }

  return stored as T;
}

export function createPersistentQueue<T>(options: {
  dbName: string;
  storeName: string;
}): PersistentQueue<T> {
  const { dbName, storeName } = options;
  const memoryKey = `${dbName}:${storeName}`;

  if (!supportsIndexedDb()) {
    return createMemoryQueue<T>(memoryKey);
  }

  return {
    async add(value) {
      try {
        return await withObjectStore(dbName, storeName, "readwrite", (store) => {
          return new Promise<number>((resolve, reject) => {
            const request = store.add({ value } satisfies StoreRecord<T>);
            request.onerror = () => {
              reject(request.error ?? new Error("IndexedDB add failed"));
            };
            request.onsuccess = () => {
              resolve(Number(request.result));
            };
          });
        });
      } catch {
        return createMemoryQueue<T>(memoryKey).add(value);
      }
    },
    async getAll(limit) {
      try {
        return await withObjectStore(dbName, storeName, "readonly", (store) => {
          return new Promise<Array<QueuedRecord<T>>>((resolve, reject) => {
            const rows: Array<QueuedRecord<T>> = [];
            const request = store.openCursor();

            request.onerror = () => {
              reject(request.error ?? new Error("IndexedDB cursor failed"));
            };

            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                resolve(typeof limit === "number" ? rows.slice(0, limit) : rows);
                return;
              }

              const id = Number(cursor.primaryKey);
              if (!Number.isNaN(id)) {
                rows.push({
                  id,
                  value: unwrapStoredValue<T>(cursor.value),
                });
              }

              if (typeof limit === "number" && rows.length >= limit) {
                resolve(rows);
                return;
              }

              cursor.continue();
            };
          });
        });
      } catch {
        return createMemoryQueue<T>(memoryKey).getAll(limit);
      }
    },
    async deleteMany(ids) {
      if (ids.length === 0) {
        return;
      }

      try {
        await withObjectStore(dbName, storeName, "readwrite", (store) => {
          return Promise.all(
            ids.map(
              (id) =>
                new Promise<void>((resolve, reject) => {
                  const request = store.delete(id);
                  request.onerror = () => {
                    reject(request.error ?? new Error("IndexedDB delete failed"));
                  };
                  request.onsuccess = () => resolve();
                }),
            ),
          ).then(() => undefined);
        });
      } catch {
        await createMemoryQueue<T>(memoryKey).deleteMany(ids);
      }
    },
    async count() {
      try {
        return await withObjectStore(dbName, storeName, "readonly", (store) => {
          return new Promise<number>((resolve, reject) => {
            const request = store.count();
            request.onerror = () => {
              reject(request.error ?? new Error("IndexedDB count failed"));
            };
            request.onsuccess = () => resolve(request.result);
          });
        });
      } catch {
        return createMemoryQueue<T>(memoryKey).count();
      }
    },
  };
}

function createMemoryQueue<T>(storeKey: string): PersistentQueue<T> {
  return {
    async add(value) {
      const store = getMemoryStore<T>(storeKey);
      const id = store.nextId;
      store.nextId += 1;
      store.values.push({ id, value });
      return id;
    },
    async getAll(limit) {
      const store = getMemoryStore<T>(storeKey);
      const rows = store.values.map((entry) => ({
        id: entry.id,
        value: entry.value,
      }));
      return typeof limit === "number" ? rows.slice(0, limit) : rows;
    },
    async deleteMany(ids) {
      const store = getMemoryStore<T>(storeKey);
      const idSet = new Set(ids);
      store.values = store.values.filter((entry) => !idSet.has(entry.id));
    },
    async count() {
      const store = getMemoryStore<T>(storeKey);
      return store.values.length;
    },
  };
}
