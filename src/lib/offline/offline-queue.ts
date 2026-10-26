export type OfflineOperationType = "pos_checkout" | "kot_send" | "payment";

export interface OfflineOperation {
  id?: number;
  operation_key: string;
  type: OfflineOperationType;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
  status: "pending" | "syncing" | "failed";
  last_error?: string;
}

const DB_NAME = "kore-bench-offline";
const STORE_NAME = "operations";
const DB_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("operation_key", "operation_key", { unique: true });
        store.createIndex("status", "status", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function enqueueOfflineOperation(operation: Omit<OfflineOperation, "id" | "created_at" | "attempts" | "status">): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const record = { ...operation, created_at: new Date().toISOString(), attempts: 0, status: "pending" } as OfflineOperation;
    store.add(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export function isOfflineQueueSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function listOfflineOperations(): Promise<OfflineOperation[]> {
  if (typeof indexedDB === "undefined") return [];
  const database = await openDatabase();
  const operations = await new Promise<OfflineOperation[]>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as OfflineOperation[]);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return operations;
}

export async function removeOfflineOperation(id: number): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function markOfflineOperationFailed(id: number, error: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      const operation = request.result as OfflineOperation | undefined;
      if (operation) store.put({ ...operation, status: "failed", attempts: operation.attempts + 1, last_error: error });
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
