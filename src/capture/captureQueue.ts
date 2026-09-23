/**
 * The captures kept this session, waiting to leave the phone together.
 *
 * Saving each shot as its own file meant a share sheet per shot, and a session
 * of ten shots arriving as ten zips. Kept here instead, they go out as one.
 *
 * Kept in IndexedDB, because iOS can end an app left in the background - to
 * take a call, or to look something up - and a session's shots should not go
 * with it. Where storage is refused (a private window), they are kept in
 * memory for as long as the page is open, and `persistent` says so.
 */

export interface KeptCapture {
  /** The capture's name, readback-YYYYMMDD-HHMMSS; its two files are named after it. */
  name: string;
  jpeg: Blob;
  sidecar: string;
}

export interface CaptureQueue {
  /** Whether what is kept survives the app being closed. */
  readonly persistent: boolean;
  /** Keeps a capture, replacing one of the same name; resolves to how many are kept. */
  add(capture: KeptCapture): Promise<number>;
  /** Everything kept, oldest first. */
  list(): Promise<KeptCapture[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

const DB_NAME = "readback";
const STORE = "captures";

/** The queue, opened once per page: every capture screen shares it. */
let opened: Promise<CaptureQueue> | null = null;

export function openCaptureQueue(): Promise<CaptureQueue> {
  opened ??= openIndexedQueue().catch(() => memoryQueue());
  return opened;
}

/** A queue held in memory, for when storage is refused - and for tests. */
export function memoryQueue(): CaptureQueue {
  const kept = new Map<string, KeptCapture>();
  return {
    persistent: false,
    async add(capture) {
      kept.set(capture.name, capture);
      return kept.size;
    },
    async list() {
      return [...kept.values()].sort(byName);
    },
    async count() {
      return kept.size;
    },
    async clear() {
      kept.clear();
    },
  };
}

async function openIndexedQueue(): Promise<CaptureQueue> {
  if (typeof indexedDB === "undefined") throw new Error("no IndexedDB");
  const db = await request<IDBDatabase>(
    (() => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "name" });
      return open;
    })()
  );

  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    persistent: true,
    async add(capture) {
      await request(store("readwrite").put(capture));
      return request(store("readonly").count());
    },
    async list() {
      return (await request<KeptCapture[]>(store("readonly").getAll())).sort(byName);
    },
    count() {
      return request(store("readonly").count());
    },
    async clear() {
      await request(store("readwrite").clear());
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Names are timestamps, so by name is oldest first. */
function byName(a: KeptCapture, b: KeptCapture): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
