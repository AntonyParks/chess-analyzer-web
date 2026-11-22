/**
 * Durable per-browser storage in IndexedDB: one record per store (game library, puzzles,
 * repertoire), each the same JSON the desktop app writes, so backups and desktop files
 * import as they are. Browser storage can be cleared by the visitor or the browser, so the
 * Settings tab offers a backup.
 */
import { openDB, type IDBPDatabase } from "idb";

export type StoreKey = "library" | "puzzles" | "repertoire" | "scan";

const DB_NAME = "chess-analyzer";
const STORE = "kv";
let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

export async function loadRecord<T>(key: StoreKey): Promise<T | undefined> {
  return (await db()).get(STORE, key) as Promise<T | undefined>;
}

export async function saveRecord(key: StoreKey, value: unknown): Promise<void> {
  await (await db()).put(STORE, value, key);
}

export async function deleteAll(): Promise<void> {
  await (await db()).clear(STORE);
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Any other record (the backup file handle, copies of unreadable data); ``undefined`` deletes it. */
export async function saveAny(key: string, value: unknown): Promise<void> {
  const d = await db();
  if (value === undefined) await d.delete(STORE, key);
  else await d.put(STORE, value, key);
}

export async function loadAny(key: string): Promise<unknown> {
  return (await db()).get(STORE, key);
}

/** Whether the browser has agreed not to clear this site's storage on its own. */
export async function isPersisted(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}
