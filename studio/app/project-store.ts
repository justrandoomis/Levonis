import type { SlicerSettings } from "three-slicer";

export interface StoredLevoProject {
  id: string;
  name: string;
  updatedAt: number;
  files: File[];
  profileId: string;
  quality: string;
  strength: string;
  support: boolean;
  settings?: SlicerSettings;
  objectCount?: number;
  plateCount?: number;
  snapshotVersion?: 2;
}

const DB_NAME = "levo-studio-projects";
const STORE = "projects";

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      let result!: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("The project save was aborted."));
    });
  } finally { db.close(); }
}

export function saveStoredProject(project: StoredLevoProject) {
  return transact("readwrite", (store) => store.put(project));
}

export function loadStoredProject(id: string) {
  return transact<StoredLevoProject | undefined>("readonly", (store) => store.get(id));
}

export async function listStoredProjects() {
  const projects = await transact<StoredLevoProject[]>("readonly", (store) => store.getAll());
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteStoredProject(id: string) {
  return transact("readwrite", (store) => store.delete(id));
}
