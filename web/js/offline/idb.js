// Minimal IndexedDB wrapper. Stores:
//   drafts — inspection drafts written on this device (keyPath local_id)
//   blobs  — photos / videos / signatures waiting to upload (keyPath key)
//   meta   — cached offline bundle etc. (keyPath key)
const DB_NAME = "elec-board";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("이 브라우저는 기기 저장소(IndexedDB)를 지원하지 않습니다."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "local_id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "key" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("기기 저장소 쓰기가 취소되었습니다. 저장 공간을 확인하세요."));
  });
}

export const idb = {
  get: (store, key) => run(store, "readonly", (s) => s.get(key)),
  all: (store) => run(store, "readonly", (s) => s.getAll()),
  put: (store, value) => run(store, "readwrite", (s) => s.put(value)),
  del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
};
