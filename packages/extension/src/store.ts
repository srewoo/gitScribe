/**
 * Durable storage (IMP-06).
 *
 * Everything lived in worker memory, so a service-worker restart lost the
 * digest, and "history" only stored metadata — clicking an entry re-fetched
 * the repository. IndexedDB is available in an MV3 worker and needs no
 * backend, so saved work can genuinely survive a restart and reopen offline.
 *
 * Layout: small metadata rows in one store, large bodies in another, written
 * in a single transaction so a body can never outlive its metadata.
 */

import type { Snapshot } from '@gitscribe/core';

export const SCHEMA_VERSION = 1;
const DB_NAME = 'gitscribe';
const DB_VERSION = 1;

const ARTIFACTS = 'artifacts';
const BODIES = 'bodies';
const JOBS = 'jobs';

export interface ArtifactMeta {
  readonly id: string;
  readonly schemaVersion: number;
  readonly snapshot: Snapshot;
  /** Canonical hash of the selection, so different selections never collide. */
  readonly selectionHash: string;
  readonly redactionPolicyVersion: string;
  readonly createdAt: number;
  readonly files: number;
  readonly tokens: number;
  readonly pinned: boolean;
  /** Bytes of the stored bodies, for the storage meter. */
  readonly bytes: number;
  readonly hasReadme: boolean;
}

export interface ArtifactBodies {
  readonly digestMarkdown: string;
  readonly readmeMarkdown?: string;
  /** Enough to re-render other formats without refetching. */
  readonly digestJson: string;
}

/** A job checkpoint, so a restart does not repeat paid work (IMP-07). */
export interface JobCheckpoint {
  readonly id: string;
  readonly digestId: string;
  readonly artifactId: string | null;
  readonly planHash: string;
  status: 'prepared' | 'running' | 'paused' | 'interrupted' | 'failed' | 'canceled' | 'completed';
  /** Completed analysis notes, keyed by the part they came from. */
  notes: Record<string, string>;
  totalParts: number;
  updatedAt: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: Array<{ part: number; error: string }>;
  error?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ARTIFACTS)) {
        const s = db.createObjectStore(ARTIFACTS, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
        s.createIndex('selectionHash', 'selectionHash');
      }
      if (!db.objectStoreNames.contains(BODIES)) db.createObjectStore(BODIES);
      if (!db.objectStoreNames.contains(JOBS)) db.createObjectStore(JOBS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open storage'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage write aborted'));
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('Storage read failed'));
  });
}

export class QuotaError extends Error {}

/** Stable hash of the options that decide what a digest contains. */
export async function selectionHash(input: unknown): Promise<string> {
  const canonical = JSON.stringify(input, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Write metadata and bodies together. If the quota is exhausted the caller
 * keeps its in-memory result — losing generated output to a storage failure
 * would be worse than not saving it.
 */
export async function saveArtifact(meta: ArtifactMeta, bodies: ArtifactBodies): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction([ARTIFACTS, BODIES], 'readwrite');
    tx.objectStore(ARTIFACTS).put(meta);
    tx.objectStore(BODIES).put(bodies, meta.id);
    await done(tx);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'QuotaExceededError') {
      throw new QuotaError(
        'Browser storage is full, so this could not be saved. The output is still open — export it, then delete older saved items.',
      );
    }
    throw e;
  } finally {
    db.close();
  }
}

export async function listArtifacts(limit = 50): Promise<ArtifactMeta[]> {
  const db = await open();
  try {
    const tx = db.transaction(ARTIFACTS, 'readonly');
    const all = await req(tx.objectStore(ARTIFACTS).getAll());
    return (all as ArtifactMeta[])
      .filter((a) => a.schemaVersion === SCHEMA_VERSION)
      .sort((a, b) => (a.pinned === b.pinned ? b.createdAt - a.createdAt : a.pinned ? -1 : 1))
      .slice(0, limit);
  } finally {
    db.close();
  }
}

export async function readArtifact(id: string): Promise<ArtifactBodies | null> {
  const db = await open();
  try {
    const tx = db.transaction(BODIES, 'readonly');
    return ((await req(tx.objectStore(BODIES).get(id))) as ArtifactBodies | undefined) ?? null;
  } finally {
    db.close();
  }
}

/** Find a previously saved artifact for exactly this snapshot and selection. */
export async function findArtifact(
  commit: string,
  hash: string,
): Promise<ArtifactMeta | null> {
  const all = await listArtifacts(200);
  return all.find((a) => a.snapshot.resolvedCommit === commit && a.selectionHash === hash) ?? null;
}

export async function deleteArtifact(id: string): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction([ARTIFACTS, BODIES], 'readwrite');
    tx.objectStore(ARTIFACTS).delete(id);
    tx.objectStore(BODIES).delete(id);
    await done(tx);
  } finally {
    db.close();
  }
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(ARTIFACTS, 'readwrite');
    const meta = (await req(tx.objectStore(ARTIFACTS).get(id))) as ArtifactMeta | undefined;
    if (meta) tx.objectStore(ARTIFACTS).put({ ...meta, pinned });
    await done(tx);
  } finally {
    db.close();
  }
}

/** Drop unpinned artifacts beyond a keep count, oldest first. */
export async function pruneArtifacts(keep: number): Promise<number> {
  const all = await listArtifacts(500);
  const unpinned = all.filter((a) => !a.pinned);
  const excess = unpinned.slice(keep);
  for (const a of excess) await deleteArtifact(a.id);
  return excess.length;
}

export async function clearAll(): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction([ARTIFACTS, BODIES, JOBS], 'readwrite');
    tx.objectStore(ARTIFACTS).clear();
    tx.objectStore(BODIES).clear();
    tx.objectStore(JOBS).clear();
    await done(tx);
  } finally {
    db.close();
  }
}

export async function storageUsage(): Promise<{ bytes: number; count: number; quota: number | null }> {
  const all = await listArtifacts(500);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  return {
    bytes: all.reduce((n, a) => n + a.bytes, 0),
    count: all.length,
    quota: est?.quota ?? null,
  };
}

/* ------------------------------------------------------------- job state */

export async function saveJob(job: JobCheckpoint): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(JOBS, 'readwrite');
    tx.objectStore(JOBS).put({ ...job, updatedAt: Date.now() });
    await done(tx);
  } catch {
    // A checkpoint failing must not kill the run it is checkpointing.
  } finally {
    db.close();
  }
}

export async function loadJob(id: string): Promise<JobCheckpoint | null> {
  const db = await open();
  try {
    const tx = db.transaction(JOBS, 'readonly');
    return ((await req(tx.objectStore(JOBS).get(id))) as JobCheckpoint | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function listJobs(): Promise<JobCheckpoint[]> {
  const db = await open();
  try {
    const tx = db.transaction(JOBS, 'readonly');
    const all = (await req(tx.objectStore(JOBS).getAll())) as JobCheckpoint[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

/**
 * On startup, a job still marked running is one the worker was killed during.
 * Mark it interrupted so it can be resumed rather than silently abandoned.
 */
export async function markAbandonedJobs(): Promise<number> {
  const jobs = await listJobs();
  let n = 0;
  for (const j of jobs) {
    if (j.status === 'running') {
      await saveJob({ ...j, status: 'interrupted' });
      n++;
    }
  }
  return n;
}

export async function deleteJob(id: string): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(JOBS, 'readwrite');
    tx.objectStore(JOBS).delete(id);
    await done(tx);
  } finally {
    db.close();
  }
}
