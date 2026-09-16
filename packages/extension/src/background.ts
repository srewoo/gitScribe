/**
 * Background service worker.
 *
 * ALL network access lives here, and that is a correctness requirement rather
 * than a style choice: the tarball request redirects to codeload.github.com,
 * which sends no permissive CORS header. Only a worker fetch backed by
 * host_permissions is exempt from CORS, so the same call from the side panel
 * would fail.
 */
import {
  GitHubClient,
  GitLabClient,
  parseTarget,
  fetchPullRequest,
  fetchCompare,
  parseChangeSpec,
  renderDiff,
  RefCache,
  SnapshotCache,
  looksLikeCommit,
  identityKey,
  type RepoIdentity,
  type Snapshot,
  buildDigest,
  applySelection,
  chooseStrategy,
  requestCost,
  render,
  renderParts,
  discoverOllama,
  DEFAULT_EXCLUDES,
  type Digest,
  type Format,
  type RepoTree,
  type Selection,
  type Forge,
} from '@gitscribe/core';

import { countExact, providerOf, CountUnsupportedError } from './counters.js';
import { loadTokens, checkToken, type ForgeId } from './tokens.js';
import {
  saveArtifact, listArtifacts, readArtifact, deleteArtifact, setPinned, pruneArtifacts,
  clearAll, storageUsage, selectionHash, findArtifact, QuotaError,
  saveJob, loadJob, listJobs, markAbandonedJobs, deleteJob,
  SCHEMA_VERSION, type JobCheckpoint,
} from './store.js';
import { generateReadme, planReadme, resolveBudgets, MAP_MAX_OUTPUT, REDUCE_MAX_OUTPUT } from './readme.js';
import { estimateCostUsd, type ModelChoice } from './llm.js';

const env = { fetch: globalThis.fetch.bind(globalThis), now: () => Date.now() };

/** A client for whichever forge the target lives on. */
async function clientFor(forge: ForgeId): Promise<GitHubClient | GitLabClient> {
  const tokens = await loadTokens();
  if (forge === 'gitlab') {
    return new GitLabClient(env, {
      token: tokens.gitlab,
      host: tokens.gitlabHost,
    });
  }
  return new GitHubClient(env, tokens.github ? { token: tokens.github } : {});
}

/**
 * Immutable content, keyed by resolved commit — never by a branch name.
 * Branch->commit resolution lives separately and expires; see snapshot.ts.
 */
const trees = new SnapshotCache<RepoTree>();
const refs = new RefCache();

/**
 * Results are addressed by id, not by "whichever was last". Two panels on two
 * repositories used to share one `lastDigest`, so a render or a generation
 * could act on the wrong repository entirely.
 */
interface DigestEntry {
  readonly id: string;
  readonly snapshot: Snapshot;
  readonly digest: Digest;
  artifactId?: string;
}
const digests = new Map<string, DigestEntry>();
const MAX_DIGESTS = 6;

function rememberDigest(snapshot: Snapshot, digest: Digest): string {
  const id = `d_${crypto.randomUUID()}`;
  if (digests.size >= MAX_DIGESTS) {
    const oldest = digests.keys().next().value;
    if (oldest !== undefined) digests.delete(oldest);
  }
  digests.set(id, { id, snapshot, digest });
  return id;
}

function requireDigest(id: string | undefined): DigestEntry {
  if (!id) throw new Error('This action needs a digestId. Rebuild the digest and retry.');
  const found = digests.get(id);
  if (!found) {
    throw new Error(
      'That digest is no longer held by the background worker (it restarted, or was evicted). Rebuild it.',
    );
  }
  return found;
}

/**
 * A README run takes minutes across many model calls. Answering it from a
 * single sendMessage was wrong: Chrome tears an MV3 service worker down while
 * the job is still going, the channel closes, and the caller sees
 * "message channel closed before a response was received".
 *
 * So the run is a JOB. Starting it answers immediately; the panel polls for
 * progress. A worker restart is then detectable and reportable rather than a
 * confusing platform error.
 */
interface ReadmeJob {
  status: 'running' | 'done' | 'error';
  done: number;
  total: number;
  label: string;
  markdown?: string;
  error?: string;
  startedAt: number;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  failures?: Array<{ part: number; error: string }>;
  grounding?: { verified: readonly string[]; unverified: readonly string[] };
}
interface KeyedJob extends ReadmeJob {
  readonly id: string;
  readonly digestId: string;
}
const jobs = new Map<string, KeyedJob>();
/** Live abort handles, so cancelling stops scheduling further calls. */
const aborts = new Map<string, AbortController>();
const MAX_JOBS = 4;

function rememberJob(j: KeyedJob): void {
  if (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs.entries()].find(([, v]) => v.status !== 'running')?.[0];
    if (oldest !== undefined) jobs.delete(oldest);
  }
  jobs.set(j.id, j);
}

/**
 * An idle MV3 worker is killed after ~30s. A pending fetch counts as activity,
 * but the gaps between model calls do not, so poke a trivial API meanwhile.
 */
let keepAlive: ReturnType<typeof setInterval> | null = null;
function startKeepAlive(): void {
  if (keepAlive !== null) return;
  keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
}
function stopKeepAlive(): void {
  if (keepAlive !== null) clearInterval(keepAlive);
  keepAlive = null;
}

type Msg =
  | { kind: 'tree'; forge: ForgeId; project: string; ref?: string; reload?: boolean }
  | { kind: 'digest'; forge: ForgeId; project: string; commit: string; selection: Selection }
  | { kind: 'checkToken'; forge: ForgeId; token: string; host?: string }
  | { kind: 'parse'; input: string }
  | { kind: 'render'; digestId: string; format: Format; budget?: number; part?: number }
  | { kind: 'ollama' }
  | { kind: 'rate' }
  | { kind: 'diagnose' }
  | { kind: 'countExact'; digestId: string; modelId: string }
  | { kind: 'planReadme'; digestId: string; map: ModelChoice; reduce: ModelChoice; ollamaWindow?: number }
  | { kind: 'startReadme'; digestId: string; map: ModelChoice; reduce: ModelChoice; chunkBudget: number; reduceAllowance: number; planHash: string }
  | { kind: 'readmeStatus'; jobId: string }
  | { kind: 'cancelReadme'; jobId: string }
  | { kind: 'resumeReadme'; jobId: string; map: ModelChoice; reduce: ModelChoice; chunkBudget: number; reduceAllowance: number }
  | { kind: 'listArtifacts' }
  | { kind: 'openArtifact'; artifactId: string }
  | { kind: 'deleteArtifact'; artifactId: string }
  | { kind: 'pinArtifact'; artifactId: string; pinned: boolean }
  | { kind: 'storageInfo' }
  | { kind: 'clearStorage' }
  | { kind: 'listJobs' }
  | { kind: 'diff'; forge: ForgeId; project: string; spec: string; format?: Format };

async function identityFor(forge: ForgeId, project: string): Promise<RepoIdentity> {
  const tokens = await loadTokens();
  const origin = forge === 'gitlab' ? (tokens.gitlabHost ?? 'gitlab.com') : 'github.com';
  return { forge, origin, project };
}

/** Split `owner/repo` for GitHub's two-argument calls. */
function split(project: string): [string, string] {
  const i = project.indexOf('/');
  return [project.slice(0, i), project.slice(i + 1)];
}

const clients = new Map<string, GitHubClient | GitLabClient>();
async function cachedClient(forge: ForgeId): Promise<GitHubClient | GitLabClient> {
  const existing = clients.get(forge);
  if (existing) return existing;
  const made = await clientFor(forge);
  clients.set(forge, made);
  return made;
}

/**
 * Resolve a possibly-moving ref to an immutable commit. A commit-looking ref
 * is taken as-is; anything else is resolved, with a short-lived cache so a
 * normal reopen re-checks rather than trusting a stale mapping.
 */
async function resolveSnapshot(
  c: GitHubClient | GitLabClient,
  identity: RepoIdentity,
  project: string,
  requestedRef: string | undefined,
  force: boolean,
): Promise<Snapshot> {
  const now = Date.now();
  const ref =
    requestedRef ??
    (c instanceof GitHubClient
      ? (await c.getRepo(...split(project))).defaultBranch
      : (await c.getRepoInfo(project)).defaultBranch);

  if (looksLikeCommit(ref)) {
    return { repository: identity, requestedRef: ref, resolvedCommit: ref, resolvedAt: now };
  }

  if (force) refs.invalidate(identity, ref);
  const cached = force ? null : refs.get(identity, ref, now);
  const commit =
    cached ??
    (c instanceof GitHubClient
      ? await c.resolveCommit(...split(project), ref)
      : await c.resolveCommit(project, ref));
  refs.set(identity, ref, commit, now);
  return { repository: identity, requestedRef: ref, resolvedCommit: commit, resolvedAt: now };
}


/**
 * Run (or resume) a generation, checkpointing each completed analysis note so
 * a worker restart never re-bills finished work.
 */
async function runGeneration(opts: {
  jobId: string;
  digestId: string;
  digest: Digest;
  map: ModelChoice;
  reduce: ModelChoice;
  mapKey: string;
  reduceKey: string;
  chunkBudget: number;
  reduceAllowance: number;
  planHash: string;
  resumeNotes: Record<string, string>;
}): Promise<void> {
  const { jobId } = opts;
  const controller = new AbortController();
  aborts.set(jobId, controller);
  startKeepAlive();

  const checkpoint: JobCheckpoint = {
    id: jobId,
    digestId: opts.digestId,
    artifactId: null,
    planHash: opts.planHash,
    status: 'running',
    notes: { ...opts.resumeNotes },
    totalParts: 0,
    updatedAt: Date.now(),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    failures: [],
  };
  await saveJob(checkpoint);

  try {
    const res = await generateReadme({
      digest: opts.digest,
      mapChoice: opts.map,
      reduceChoice: opts.reduce,
      mapKey: opts.mapKey,
      reduceKey: opts.reduceKey,
      chunkBudget: opts.chunkBudget,
      reduceAllowance: opts.reduceAllowance,
      resumeNotes: opts.resumeNotes,
      signal: controller.signal,
      onNote: async (part, note) => {
        checkpoint.notes[String(part)] = note;
        await saveJob(checkpoint);
      },
      onProgress: (done, total, label) => {
        const j = jobs.get(jobId);
        if (j) { j.done = done; j.total = total; j.label = label; }
        checkpoint.totalParts = total;
      },
    });

    const prev = jobs.get(jobId);
    rememberJob({
      id: jobId, digestId: opts.digestId,
      status: 'done', done: 1, total: 1, label: 'Done',
      startedAt: prev?.startedAt ?? Date.now(),
      markdown: res.markdown, calls: res.calls,
      inputTokens: res.inputTokens, outputTokens: res.outputTokens,
      failures: [...res.failures], grounding: res.grounding,
    });
    await saveJob({
      ...checkpoint, status: 'completed',
      calls: res.calls, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
      failures: [...res.failures],
    });

    // Attach the README to the saved artifact so it reopens offline.
    await attachReadme(opts.digestId, res.markdown).catch(() => { /* quota */ });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const prev = jobs.get(jobId);
    rememberJob({
      id: jobId, digestId: opts.digestId,
      status: 'error', done: 0, total: 0, label: 'Failed',
      startedAt: prev?.startedAt ?? Date.now(), error: message,
    });
    // Keep the notes: a resume can reuse every completed part.
    await saveJob({
      ...checkpoint,
      status: /cancel/i.test(message) ? 'canceled' : 'interrupted',
      error: message,
    });
  } finally {
    aborts.delete(jobId);
    stopKeepAlive();
  }
}

/** Store the generated README next to the digest it came from. */
async function attachReadme(digestId: string, markdown: string): Promise<void> {
  const entry = digests.get(digestId);
  if (!entry) return;
  const metas = await listArtifacts(200);
  const meta = metas.find((m) => m.id === entry.artifactId);
  if (!meta) return;
  const bodies = await readArtifact(meta.id);
  if (!bodies) return;
  await saveArtifact(
    { ...meta, hasReadme: true, bytes: meta.bytes + markdown.length },
    { ...bodies, readmeMarkdown: markdown },
  );
}

async function handle(msg: Msg): Promise<unknown> {
  if (msg.kind === 'parse') return { target: parseTarget(msg.input) };
  if (msg.kind === 'checkToken') {
    return await checkToken(msg.forge, msg.token, msg.host);
  }
  // A token may have changed since the last call; rebuild lazily.
  if (msg.kind === 'tree') clients.clear();

  const forge: ForgeId = 'forge' in msg ? msg.forge : 'github';
  const c = await cachedClient(forge);

  switch (msg.kind) {
    case 'tree': {
      const identity = await identityFor(forge, msg.project);
      const snapshot = await resolveSnapshot(c, identity, msg.project, msg.ref, msg.reload === true);

      const cached = trees.get(snapshot);
      const tree =
        cached ??
        (c instanceof GitHubClient
          ? await c.getTree(...split(msg.project), snapshot.resolvedCommit)
          : await c.getTree(msg.project, snapshot.resolvedCommit));
      trees.set(snapshot, tree);

      const sel = applySelection(tree.files, {
        exclude: [...DEFAULT_EXCLUDES],
        include: [],
        overrides: {},
      });
      return {
        tree,
        snapshot,
        defaultExcludes: DEFAULT_EXCLUDES,
        preselectedTokens: sel.totalTokens,
        rate: c.rateLimit,
        fromCache: cached !== undefined,
        forge,
        sizesUnknown: tree.sizesUnknown === true,
      };
    }

    case 'digest': {
      const identity = await identityFor(forge, msg.project);
      const snapshot: Snapshot = {
        repository: identity,
        requestedRef: msg.commit,
        resolvedCommit: msg.commit,
        resolvedAt: Date.now(),
      };
      const tree = trees.get(snapshot);
      if (!tree) throw new Error('That snapshot is no longer loaded. Reopen the repository.');

      const selected = applySelection(tree.files, msg.selection);
      const strategy = chooseStrategy(selected.files, tree);
      const [owner, repo] = c instanceof GitHubClient ? split(msg.project) : ['', msg.project];
      const digest = await buildDigest(env, c, owner, repo, tree, { selection: msg.selection });
      const digestId = rememberDigest(snapshot, digest);

      // Persist it so a worker restart, or a later offline session, can reopen
      // the exact output without refetching anything.
      const markdown = render(digest, 'md');
      const hash = await selectionHash(msg.selection);
      let savedAs: string | null = null;
      let saveError: string | null = null;
      try {
        const artifactId = `a_${snapshot.resolvedCommit.slice(0, 8)}_${hash}`;
        await saveArtifact(
          {
            id: artifactId,
            schemaVersion: SCHEMA_VERSION,
            snapshot,
            selectionHash: hash,
            redactionPolicyVersion: 'v1',
            createdAt: Date.now(),
            files: digest.files.length,
            tokens: digest.totalTokens,
            pinned: false,
            bytes: markdown.length,
            hasReadme: false,
          },
          { digestMarkdown: markdown, digestJson: render(digest, 'json') },
        );
        const held = digests.get(digestId);
        if (held) held.artifactId = artifactId;
        savedAs = artifactId;
        await pruneArtifacts(20);
      } catch (e) {
        // Never lose the in-memory result to a storage failure.
        saveError = e instanceof QuotaError ? e.message : 'Could not save this digest locally.';
      }

      return {
        digestId,
        savedAs,
        saveError,
        snapshot,
        summary: {
          files: digest.files.length,
          tokens: digest.totalTokens,
          truncations: digest.truncations,
          redactions: digest.redactions,
          requests: requestCost(strategy, selected.files),
          strategy,
        },
        text: markdown,
        rate: c.rateLimit,
      };
    }

    /**
     * IMP-04: preparing a plan sends nothing and spends nothing. It reports
     * where content will go, what it may cost, and what is uncertain. Starting
     * is a separate, explicit act.
     */
    case 'planReadme': {
      const entry = requireDigest(msg.digestId);
      const budgets = resolveBudgets(msg.map, msg.reduce, msg.ollamaWindow);

      if (budgets.map.inputAllowance === null || budgets.reduce.inputAllowance === null) {
        return {
          ok: true,
          blocked: true,
          mapReason: budgets.map.reason,
          reduceReason: budgets.reduce.reason,
        };
      }

      const plan = planReadme(entry.digest, msg.map, msg.reduce, budgets.map.inputAllowance);

      // Cost the MAXIMA we will actually request, not the sizes we hope for.
      const mapWorst = estimateCostUsd(msg.map, plan.mapInputTokens, plan.parts * MAP_MAX_OUTPUT);
      const reduceWorst = estimateCostUsd(msg.reduce, plan.reduceInputTokens, REDUCE_MAX_OUTPUT);
      const worstCase = mapWorst === null || reduceWorst === null ? null : mapWorst + reduceWorst;

      const destinations = [...new Set([msg.map.provider, msg.reduce.provider])];

      return {
        ok: true,
        blocked: false,
        planHash:
          `${msg.digestId}:${msg.map.provider}/${msg.map.model}:` +
          `${msg.reduce.provider}/${msg.reduce.model}:${budgets.map.inputAllowance}`,
        snapshot: entry.snapshot,
        parts: plan.parts,
        calls: plan.calls,
        files: entry.digest.files.length,
        mapInputTokens: plan.mapInputTokens,
        mapAllowance: budgets.map.inputAllowance,
        reduceAllowance: budgets.reduce.inputAllowance,
        mapReason: budgets.map.reason,
        reduceReason: budgets.reduce.reason,
        estimatedCostUsd: plan.estimatedCostUsd,
        worstCaseCostUsd: worstCase,
        destinations,
        sendsCode: msg.map.provider !== 'ollama',
        sendsNotes: msg.reduce.provider !== 'ollama',
      };
    }

    case 'countExact': {
      const { digest } = requireDigest(msg.digestId);
      const provider = providerOf(msg.modelId);
      if (!provider) {
        throw new Error(
          'That model has no counting endpoint. Local models report an exact window already.',
        );
      }
      const { keys } = await chrome.storage.local.get('keys');
      const key = (keys as Record<string, string> | undefined)?.[provider];
      if (!key) throw new Error(`No ${provider} API key saved. Add one in settings.`);
      try {
        return await countExact(provider, key, msg.modelId, render(digest, 'md'));
      } catch (e) {
        if (e instanceof CountUnsupportedError) throw new Error(e.message);
        throw e;
      }
    }

    case 'readmeStatus':
      return jobs.get(msg.jobId) ?? { status: 'none' };

    case 'startReadme': {
      const entry = requireDigest(msg.digestId);
      const running = [...jobs.values()].find((j) => j.status === 'running');
      if (running) return { started: false, reason: 'A run is already in progress.' };

      const { keys } = await chrome.storage.local.get('keys');
      const store = (keys as Record<string, string> | undefined) ?? {};
      const keyFor = (c: ModelChoice): string => {
        if (c.provider === 'ollama') return '';
        const k = store[c.provider];
        if (!k) throw new Error(`No ${c.provider} API key saved. Add one in settings.`);
        return k;
      };
      // Resolve keys BEFORE starting, so a missing key is an immediate, clear
      // error rather than a job that fails a minute later.
      const mapKey = keyFor(msg.map);
      const reduceKey = keyFor(msg.reduce);
      const digest = entry.digest;

      const jobId = `j_${crypto.randomUUID()}`;
      rememberJob({
        id: jobId, digestId: entry.id,
        status: 'running', done: 0, total: 0, label: 'Starting', startedAt: Date.now(),
      });

      // Deliberately not awaited: starting returns at once and the panel polls.
      void runGeneration({
        jobId, digestId: entry.id, digest,
        map: msg.map, reduce: msg.reduce, mapKey, reduceKey,
        chunkBudget: msg.chunkBudget, reduceAllowance: msg.reduceAllowance,
        planHash: msg.planHash, resumeNotes: {},
      });

      return { started: true, jobId };
    }

    case 'render': {
      const { digest } = requireDigest(msg.digestId);
      if (msg.budget && msg.budget > 0) {
        const parts = renderParts(digest, msg.format, { budget: msg.budget });
        const idx = Math.min(Math.max(1, msg.part ?? 1), parts.length);
        return { text: parts[idx - 1]!, part: idx, parts: parts.length };
      }
      return { text: render(digest, msg.format), part: 1, parts: 1 };
    }

    case 'ollama': {
      // Local access is optional now; absence is not an error, just no models.
      const allowed = await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] });
      if (!allowed) return { models: [], needsPermission: true };
      return { models: await discoverOllama(env.fetch) };
    }

    case 'rate':
      return { rate: c.rateLimit };

    /**
     * The M0 spike, kept as a shipped diagnostic: proves from inside the
     * worker that the api.github.com -> codeload.github.com redirect really
     * is exempt from CORS here. If this ever fails, the whole content
     * strategy has to change, so it is worth being able to check on demand.
     */
    case 'resumeReadme': {
      const cp = await loadJob(msg.jobId);
      if (!cp) throw new Error('That run is no longer in storage.');
      if (cp.status === 'completed') throw new Error('That run already finished.');
      const entry = digests.get(cp.digestId);
      if (!entry) {
        throw new Error(
          'The digest for that run is gone (the worker restarted). Reopen the repository and rebuild it — the completed analysis notes are still saved and will be reused.',
        );
      }
      const { keys } = await chrome.storage.local.get('keys');
      const store = (keys as Record<string, string> | undefined) ?? {};
      const keyFor = (c: ModelChoice): string => {
        if (c.provider === 'ollama') return '';
        const k = store[c.provider];
        if (!k) throw new Error(`No ${c.provider} API key saved.`);
        return k;
      };
      rememberJob({
        id: msg.jobId, digestId: cp.digestId,
        status: 'running', done: 0, total: cp.totalParts,
        label: `Resuming (${Object.keys(cp.notes).length} part(s) already done)`,
        startedAt: Date.now(),
      });
      void runGeneration({
        jobId: msg.jobId, digestId: cp.digestId, digest: entry.digest,
        map: msg.map, reduce: msg.reduce,
        mapKey: keyFor(msg.map), reduceKey: keyFor(msg.reduce),
        chunkBudget: msg.chunkBudget, reduceAllowance: msg.reduceAllowance,
        planHash: cp.planHash, resumeNotes: cp.notes,
      });
      return { resumed: true, reusedParts: Object.keys(cp.notes).length };
    }

    case 'cancelReadme': {
      aborts.get(msg.jobId)?.abort();
      const j = jobs.get(msg.jobId);
      if (j) rememberJob({ ...j, status: 'error', label: 'Cancelled', error: 'Cancelled. Calls already submitted may still be billed.' });
      const cp = await loadJob(msg.jobId);
      if (cp) await saveJob({ ...cp, status: 'canceled' });
      return { cancelled: true };
    }

    case 'listArtifacts':
      return { artifacts: await listArtifacts() };

    case 'openArtifact': {
      const bodies = await readArtifact(msg.artifactId);
      if (!bodies) throw new Error('That saved item is no longer in storage.');
      // Reopening is offline: nothing is fetched.
      return { bodies };
    }

    case 'deleteArtifact':
      await deleteArtifact(msg.artifactId);
      return { deleted: true };

    case 'pinArtifact':
      await setPinned(msg.artifactId, msg.pinned);
      return { pinned: msg.pinned };

    case 'storageInfo':
      return await storageUsage();

    case 'clearStorage':
      await clearAll();
      return { cleared: true };

    case 'listJobs':
      return { jobs: await listJobs() };

    /** IMP-11: changes mode. GitHub only for now, and it says so. */
    case 'diff': {
      if (!(c instanceof GitHubClient)) {
        throw new Error(
          'Change digests are GitHub-only at the moment. GitLab merge requests need their own adapter, which is not built yet.',
        );
      }
      const [owner, repo] = split(msg.project);
      const parsed = parseChangeSpec(msg.spec);
      const d =
        parsed.kind === 'pr'
          ? await fetchPullRequest(env, c, owner, repo, parsed.number)
          : await fetchCompare(env, c, owner, repo, parsed.base, parsed.head);

      return {
        kind: d.kind,
        title: d.title,
        base: d.base,
        head: d.head,
        files: d.files.map((f) => ({
          path: f.path, status: f.status,
          additions: f.additions, deletions: f.deletions,
          hasPatch: f.patch !== null,
        })),
        additions: d.additions,
        deletions: d.deletions,
        tokens: d.totalTokens,
        truncations: d.truncations,
        redactions: d.redactions.length,
        text: renderDiff(d, msg.format ?? 'md'),
        rate: c.rateLimit,
      };
    }

    case 'diagnose': {
      const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
      try {
        const res = await env.fetch(
          'https://api.github.com/repos/sindresorhus/slugify/tarball/main',
          { redirect: 'follow' },
        );
        steps.push({
          step: 'tarball fetch follows redirect to codeload',
          ok: res.ok,
          detail: `${res.status} ${res.url}`,
        });
        if (res.body) {
          const gunzip = new DecompressionStream('gzip');
          const reader = res.body.pipeThrough(
            gunzip as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
          ).getReader();
          const first = await reader.read();
          await reader.cancel();
          steps.push({
            step: 'DecompressionStream gzip in the worker',
            ok: !first.done && (first.value?.length ?? 0) > 0,
            detail: `${first.value?.length ?? 0} bytes decompressed`,
          });
        }
      } catch (e) {
        steps.push({ step: 'tarball fetch', ok: false, detail: String(e) });
      }
      return { steps };
    }

    default: {
      // Exhaustiveness guard: adding a message kind without a case, or
      // deleting a case, now fails the type check instead of returning
      // undefined to the caller at runtime.
      const unreachable: never = msg;
      throw new Error(`Unhandled message: ${JSON.stringify(unreachable).slice(0, 80)}`);
    }
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  handle(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // keep the channel open for the async reply
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

/**
 * A job still marked running when the worker starts is one the worker was
 * killed during. Mark it interrupted so it can be offered for resume rather
 * than silently abandoned (IMP-07).
 */
void markAbandonedJobs().catch(() => { /* storage unavailable */ });
