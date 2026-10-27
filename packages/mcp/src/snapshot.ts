import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import {
  GitHubClient,
  GitLabClient,
  buildDigest,
  buildGraph,
  groupGraph,
  planTour,
  readTarGz,
  safeRelative,
  isSensitivePath,
  pickImages,
  snapshotExtras,
  nodeEnv,
  type RepoTree,
  type Selection,
} from '@gitscribe/core';

/**
 * Write a repository, pinned to one commit, into a local folder that another
 * tool (e.g. /brag) can read as if it were a checkout. Text is redacted,
 * sensitive files are not written at all, and no path can leave the folder.
 */

export interface SnapshotInput {
  readonly forge: 'github' | 'gitlab';
  readonly client: GitHubClient | GitLabClient;
  readonly owner: string;
  readonly repo: string;
  readonly tree: RepoTree;
  readonly selection: Selection;
  readonly dir?: string | undefined;
}

export interface SnapshotResult {
  readonly dir: string;
  readonly textFiles: number;
  readonly images: number;
  readonly skipped: readonly string[];
  readonly redacted: number;
}

const MAX_IMAGE_BYTES = 1_000_000;
const MAX_IMAGES = 40;

function defaultDir(owner: string, repo: string, ref: string): string {
  const name = `${owner ? `${owner}-` : ''}${repo}-${ref.slice(0, 7)}`.replace(/[^\w.-]+/g, '-');
  return join(tmpdir(), 'gitscribe', name);
}

async function images(input: SnapshotInput, want: ReadonlySet<string>): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (!want.size) return out;
  const { client, tree } = input;
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = client instanceof GitHubClient
      ? await client.getTarball(input.owner, input.repo, tree.ref)
      : await client.getArchive(input.repo, tree.ref);
  } catch (e) {
    // GitLab shapes archive downloads (406); images are optional, so read them one by one.
    if (!(client instanceof GitLabClient) || (e as { status?: number }).status !== 406) throw e;
    for (const path of want) {
      const bytes = await client.getRawFile(input.repo, tree.ref, path);
      if (bytes.length <= MAX_IMAGE_BYTES) out.set(path, bytes);
    }
    return out;
  }
  for await (const e of readTarGz(stream, (p) => want.has(p), { maxEntryBytes: MAX_IMAGE_BYTES })) {
    out.set(e.path, e.bytes);
  }
  return out;
}

export async function writeSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const { client, owner, repo, tree } = input;
  const root = resolve(input.dir ?? defaultDir(owner, repo, tree.ref));
  const skipped: string[] = [];

  /** The one place a path becomes a file; checked twice, by shape and by resolution. */
  const write = async (rel: string, data: string | Uint8Array): Promise<boolean> => {
    const safe = safeRelative(rel);
    const target = safe ? resolve(root, safe) : '';
    if (!safe || !target.startsWith(root + sep)) { skipped.push(`${rel} (unsafe path)`); return false; }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return true;
  };

  const digest = await buildDigest(nodeEnv, client, owner, repo, tree, { selection: input.selection, redact: true });
  let textFiles = 0;
  for (const f of digest.files) {
    if (isSensitivePath(f.path)) { skipped.push(f.path); continue; }
    if (await write(f.path, f.text)) textFiles++;
  }

  const wanted = new Set(pickImages(tree.files, MAX_IMAGES, MAX_IMAGE_BYTES));
  let imageCount = 0;
  for (const [path, bytes] of await images(input, wanted)) {
    if (await write(path, bytes)) imageCount++;
  }

  const graph = buildGraph(digest);
  const view = groupGraph(graph);
  const tour = planTour(graph, view, undefined, 'onboarding', `${owner ? `${owner}/` : ''}${repo}`);
  const sensitive = skipped.filter((s) => !s.endsWith('(unsafe path)'));
  for (const [name, text] of Object.entries(snapshotExtras(digest, graph, view, tour, sensitive))) {
    await write(`.gitscribe/${name}`, text);
  }

  return {
    dir: root, textFiles, images: imageCount, skipped,
    redacted: digest.redactions.reduce((n, r) => n + r.count, 0),
  };
}
