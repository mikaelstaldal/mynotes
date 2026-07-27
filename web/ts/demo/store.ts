// Browser-local persistence for the demo backend: the counterpart of
// internal/repository and its SQLite database.
//
// Storage is IndexedDB rather than localStorage, which a service worker cannot
// reach — localStorage is a synchronous API and is simply not exposed to worker
// contexts. IndexedDB is the same kind of thing from the user's point of view
// (per-origin storage that lives in the browser, survives a reload, and is
// cleared with the site's data), and it also holds artifact bytes without
// base64-inflating them into a ~5 MB string quota.
//
// The note and tag dataset is one record, cached in memory and rewritten
// wholesale on every mutation — for a demo-sized store that is far simpler than
// mirroring the relational schema, and every read is then a plain array scan.
// Artifact bytes live in their own store so a note edit never rewrites them.
//
// See model.ts for why these are globals rather than module exports.

const DB_NAME = 'mynotes-demo';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const ARTIFACT_STORE = 'artifacts';
const STATE_KEY = 'state';
const CONFIG_KEY = 'config';

/** Deployment facts carried over from the seed, kept so it is fetched once. */
interface DemoConfig {
  lucideBundle: string;
}

/** An artifact record: metadata plus its bytes. */
interface StoredArtifact extends DemoArtifact {
  data: ArrayBuffer;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise === null) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
        if (!db.objectStoreNames.contains(ARTIFACT_STORE)) {
          db.createObjectStore(ARTIFACT_STORE, { keyPath: 'sha256' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('cannot open the demo database'));
    });
  }
  return dbPromise;
}

async function readRecord<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readonly');
  return promisifyRequest<T | undefined>(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

async function writeRecord(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  await promisifyRequest(key === undefined ? objectStore.put(value) : objectStore.put(value, key));
  await transactionDone(tx);
}

async function deleteRecord(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readwrite');
  await promisifyRequest(tx.objectStore(store).delete(key));
  await transactionDone(tx);
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * A write that exceeds the origin's storage quota. Reported as 507 so the UI
 * shows the message rather than a bare network failure — the one failure mode
 * the real server does not have.
 */
function quotaError(err: unknown): ApiError {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') {
    return new ApiError(507, 'browser storage is full — delete a note or an image to free space');
  }
  return new ApiError(500, 'storage error: ' + String(err));
}

let cachedState: DemoState | null = null;
let cachedConfig: DemoConfig | null = null;

/**
 * The dataset, loading it (and seeding on first ever run) if needed. Callers
 * must hold the mutex — see withStore.
 */
async function loadState(): Promise<DemoState> {
  if (cachedState === null) {
    const stored = await readRecord<DemoState>(KV_STORE, STATE_KEY);
    cachedState = stored ?? (await seedStore());
  }
  return cachedState;
}

/** Persists the in-memory dataset. */
async function saveState(state: DemoState): Promise<void> {
  cachedState = state;
  try {
    await writeRecord(KV_STORE, state, STATE_KEY);
  } catch (err) {
    // The cache no longer reflects storage; drop it so the next read reloads.
    cachedState = null;
    throw quotaError(err);
  }
}

/**
 * The deployment config recorded at seed time. Seeding normally writes it, so
 * an absent record means the seed document was unreachable then; re-read it now
 * rather than re-seeding, which would throw away whatever the user has written
 * since.
 */
async function loadConfig(): Promise<DemoConfig> {
  if (cachedConfig === null) {
    const stored = await readRecord<DemoConfig>(KV_STORE, CONFIG_KEY);
    if (stored !== undefined) {
      cachedConfig = stored;
    } else {
      const seed = await fetchSeed();
      cachedConfig = { lucideBundle: seed?.lucideBundle ?? '' };
      if (seed !== null) await writeRecord(KV_STORE, cachedConfig, CONFIG_KEY);
    }
  }
  return cachedConfig;
}

/**
 * Fills an empty store from demo-data.json, the same content `mynotes -demo`
 * writes into SQLite (see internal/demo). Runs once: after this the store is
 * the user's, and clearing the site's data is what brings the demo content
 * back.
 */
async function seedStore(): Promise<DemoState> {
  const state: DemoState = { nextNoteId: 1, notes: [], tags: [] };
  const seed = await fetchSeed();
  if (seed !== null) {
    state.tags = seed.tags.map((t) => ({ slug: t.slug, createdAt: t.createdAt }));
    state.notes = seed.notes.map((n) => ({ ...n, id: state.nextNoteId++ }));
    for (const a of seed.artifacts) {
      await writeRecord(ARTIFACT_STORE, {
        sha256: a.sha256,
        contentType: a.contentType,
        createdAt: a.createdAt,
        data: base64ToBytes(a.data).buffer,
      });
    }
    await writeRecord(KV_STORE, { lucideBundle: seed.lucideBundle }, CONFIG_KEY);
    cachedConfig = { lucideBundle: seed.lucideBundle };
  }
  await writeRecord(KV_STORE, state, STATE_KEY);
  return state;
}

/**
 * Loads demo-data.json from alongside the worker, or null when it is missing.
 * A missing seed is not fatal: the demo then simply starts empty.
 */
async function fetchSeed(): Promise<DemoSeed | null> {
  try {
    const response = await fetch(seedURL(), { cache: 'no-cache' });
    if (!response.ok) return null;
    return (await response.json()) as DemoSeed;
  } catch {
    return null;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Artifacts ────────────────────────────────────────────────────────────────

async function getArtifact(sha256: string): Promise<StoredArtifact | undefined> {
  return readRecord<StoredArtifact>(ARTIFACT_STORE, sha256);
}

async function putArtifact(artifact: StoredArtifact): Promise<void> {
  try {
    await writeRecord(ARTIFACT_STORE, artifact);
  } catch (err) {
    throw quotaError(err);
  }
}

async function removeArtifact(sha256: string): Promise<void> {
  await deleteRecord(ARTIFACT_STORE, sha256);
}

// ── Serialization ────────────────────────────────────────────────────────────

let mutex: Promise<unknown> = Promise.resolve();

/**
 * Runs fn with exclusive access to the store. Fetch events arrive concurrently
 * and every mutation is read-modify-write over the whole dataset, so they are
 * serialized here — the transactional guarantee the SQLite writes have on the
 * server.
 */
function withStore<T>(fn: (state: DemoState) => Promise<T>): Promise<T> {
  const run = mutex.then(async () => fn(await loadState()));
  // Keep the chain alive after a rejection, or one failed request would wedge
  // every later one.
  mutex = run.catch(() => undefined);
  return run;
}
