# GitScribe — Technical Architecture

Companion to `SPEC.md`. Every number here is either marked **[verified]** with its source or
**[estimate]**. No backend exists anywhere in this document.

## 1. Monorepo layout

```
gitscribe/
  packages/
    core/          pure TS. zero DOM, zero node builtins. all logic lives here.
      src/
        github/    endpoint clients, parameterised by an injected fetch
        tree/      tree assembly, glob rules, selection algebra
        tokens/    estimator + model registry
        digest/    IR construction + renderers (md | xml | json | txt)
        archive/   tar + gzip stream decoding
        index.ts   the public API surface in §2
    extension/     WXT MV3. popup, options, content script, background worker.
    mcp/           stdio MCP server, npx-runnable, ~300 lines over core.
  docs/
```

`core` compiles to ESM with `"lib": ["ES2022"]` only — no `dom`, no `@types/node`. Anything
environment-specific is injected. That is what makes one package serve both a service worker
and a Node process without a compatibility layer.

Build: pnpm workspaces + tsc project references. `core` is the only package with tests worth
the name; extension and mcp are adapters and are tested at the seam.

## 2. `core` public API

```ts
// --- environment injection -------------------------------------------------
export interface Env {
  readonly fetch: typeof globalThis.fetch;   // service worker's, or node's
  readonly now: () => number;
  readonly cache?: BlobCache;                // optional; see §6
}
export interface BlobCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

// --- github ----------------------------------------------------------------
export interface RepoRef { readonly owner: string; readonly repo: string; readonly ref: string; }

export interface RateLimit { limit: number; remaining: number; resetAt: number /* epoch ms */; }

export interface GitHubClient {
  readonly rateLimit: RateLimit | undefined;   // last observed, from response headers
  getRepo(owner: string, repo: string): Promise<RepoMeta>;
  resolveRef(owner: string, repo: string, ref: string): Promise<{ sha: string }>;
  getTree(ref: RepoRef, opts?: { recursive?: boolean; path?: string }): Promise<RawTree>;
  getTarball(ref: RepoRef, onProgress?: (bytes: number) => void): Promise<ReadableStream<Uint8Array>>;
  getBlob(ref: RepoRef, sha: string): Promise<Uint8Array>;
  getPullFiles(ref: RepoRef, number: number, limit?: number): Promise<DiffFile[]>;
  compare(ref: RepoRef, base: string, head: string): Promise<CompareResult>;
  getUser(): Promise<{ login: string }>;       // token validation only
}

export function createGitHubClient(env: Env, auth?: { token: string }): GitHubClient;
export interface RawTree {
  readonly sha: string;
  readonly truncated: boolean;                 // GitHub's flag, propagated verbatim
  readonly entries: readonly RawTreeEntry[];
}
export interface RawTreeEntry {
  readonly path: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
  readonly size?: number;                      // absent for trees and submodules
}

export interface DiffFile {
  readonly path: string; readonly previousPath?: string; readonly sha?: string;
  readonly status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  readonly additions: number; readonly deletions: number;
  readonly patch?: string;                     // absent for binary and oversized files
}
export interface CompareResult {
  readonly baseSha: string; readonly headSha: string;
  readonly files: readonly DiffFile[]; readonly truncation?: Truncation;
}
export interface Truncation {
  readonly reason: 'compare-300-file-cap' | 'pr-3000-file-cap' | 'tree-entry-cap' | 'size-budget';
  readonly omittedCount?: number;
  readonly detail: string;                     // shown to the user verbatim
}

// --- tree + selection ------------------------------------------------------
export interface FileNode {
  readonly path: string; readonly name: string; readonly sha: string; readonly size: number;
  readonly kind: 'text' | 'binary' | 'generated' | 'vendored' | 'oversized';
  readonly tokens: number;                     // ESTIMATE, from size+ext (§5)
}
export interface DirNode {
  readonly path: string; readonly name: string; readonly children: readonly TreeNode[];
  readonly fileCount: number; readonly size: number; readonly tokens: number; // rollups
}
export type TreeNode = ({ readonly node: 'file' } & FileNode) | ({ readonly node: 'dir' } & DirNode);

export function buildTree(raw: RawTree, opts?: { classify?: Classifier }): DirNode;

export interface Rules {
  readonly include: readonly string[];         // globs; empty = include all
  readonly exclude: readonly string[];
  readonly respectGitignore: boolean;
  readonly maxFileBytes: number;               // default 512_000
}
export const DEFAULT_RULES: Rules;

/** Layered: defaults -> rules -> explicit overrides. Overrides always win. */
export interface Selection {
  readonly selected: ReadonlySet<string>;      // file paths
  readonly reasons: ReadonlyMap<string, 'default' | 'rule' | 'override'>;
}
export function applyRules(
  tree: DirNode, rules: Rules, overrides?: ReadonlyMap<string, boolean>,
  gitignore?: readonly string[],
): Selection;

/** Incremental: recompute one subtree after a click. O(subtree), not O(repo). */
export function toggle(tree: DirNode, sel: Selection, path: string, on: boolean): Selection;

export function totals(tree: DirNode, sel: Selection): { files: number; bytes: number; tokens: number };

// --- tokens + models -------------------------------------------------------
export interface ModelInfo {
  readonly id: string; readonly label: string;
  readonly family: 'claude' | 'gpt' | 'gemini' | 'grok' | 'ollama';
  readonly contextWindow: number;
  readonly windowSource: 'vendor-docs' | 'runtime' | 'estimate';
  readonly verifiedOn?: string;                // ISO date; required when source=vendor-docs
}
export const MODELS: readonly ModelInfo[];

/** size-and-extension heuristic. No tokenizer is shipped. See §5. */
export function estimateTokens(bytes: number, path: string, family: ModelInfo['family']): number;
export function estimateTokensFromText(text: string, family: ModelInfo['family']): number;

export interface OllamaProbe { reachable: boolean; models: readonly ModelInfo[]; }
export function probeOllama(env: Env, timeoutMs?: number): Promise<OllamaProbe>;

export interface BudgetReport {
  readonly model: ModelInfo;
  readonly used: number; readonly reserve: number; readonly window: number;
  readonly overBy: number;                     // 0 when it fits
  readonly suggestions: readonly { path: string; tokens: number; why: string }[];
}
export function budget(
  tree: DirNode, sel: Selection, model: ModelInfo, reserveRatio?: number,
): BudgetReport;

// --- digest ----------------------------------------------------------------
export type DigestMode =
  | { kind: 'repo'; ref: RepoRef }
  | { kind: 'pr'; ref: RepoRef; number: number; includeFullFiles: boolean }
  | { kind: 'compare'; ref: RepoRef; base: string; head: string; includeFullFiles: boolean };

export interface DigestFile { readonly path: string; readonly text: string; readonly tokens: number; }
export interface Digest {
  readonly mode: DigestMode; readonly generatedAt: number; readonly treeText: string;
  readonly summary: { files: number; bytes: number; tokens: number; tokensAreEstimates: true };
  readonly files: readonly DigestFile[];
  readonly diffs?: readonly DiffFile[];
  readonly truncations: readonly Truncation[];
  readonly redactions: readonly { path: string; line: number; rule: string }[];
}

export interface BuildOptions {
  readonly rules: Rules;
  readonly selection?: Selection;               // omit to derive from rules
  readonly model?: ModelInfo;
  readonly redactSecrets: boolean;              // default true
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: { phase: string; done: number; total: number }) => void;
}
export function buildDigest(c: GitHubClient, mode: DigestMode, o: BuildOptions): Promise<Digest>;

export type Format = 'markdown' | 'xml' | 'json' | 'text';
export function render(digest: Digest, format: Format): string;
```

Everything above is synchronous and pure except the four functions taking `Env` or
`GitHubClient`. That boundary is the whole design.

## 3. GitHub API strategy — one choice per case

All limits below are **[verified]** from GitHub REST documentation
(`rest/git/trees`, `rest/repos/contents`, `rest/commits/commits`, `rest/pulls/pulls`,
`rest/using-the-rest-api/rate-limits-for-the-rest-api`).

| Case | Endpoint | Why this one |
|---|---|---|
| Tree listing | `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` | One request returns path, type, size, and blob SHA for the entire repo. The contents API would cost one request per directory and caps directories at 1,000 entries; the tarball would cost a full download just to draw a tree. Caps: 100,000 entries / 7 MB, signalled by `truncated: true`. |
| Tree, truncated | non-recursive `git/trees/{sha}` per expanded directory | Lazy, on node expansion. Costs requests only for what the user actually opens. |
| Bulk file contents | `GET /repos/{o}/{r}/tarball/{ref}` | **One** rate-limit unit for the entire repo. This is the decisive argument under a 60/hr anonymous budget: N blob fetches for a 300-file selection is 300 units; the tarball is 1. Redirects to `codeload.github.com` (302), which must be in `host_permissions`. |
| Sparse file contents | `GET /repos/{o}/{r}/git/blobs/{sha}` | Used when the selection is small. Returns base64 with no 1 MB ceiling (unlike the contents API, which only serves 1–100 MB files under the raw media type). |
| PR diff | `GET /repos/{o}/{r}/pulls/{n}/files?per_page=100` | Gives structured `patch` per file. Cap 3,000 files, 30/page default — we page at 100. |
| Commit range / branch compare | `GET /repos/{o}/{r}/compare/{base}...{head}` | Only endpoint that resolves a merge base. Hard cap: 300 changed files for the whole comparison, file list on page 1 only, no pagination past it. |
| Token validation | `GET /user` | Single call, confirms the token and returns the authenticated rate limit in headers. |

**Tarball vs blobs — the decision rule.** Use per-blob fetches when
`selectedFiles ≤ 25 AND selectedBytes ≤ 0.15 × repoBytes`; otherwise use the tarball. Below that
threshold the request cost is affordable and the bandwidth saving is large; above it the
rate-limit cost dominates and the tarball wins on both axes. The threshold constants are
**[estimate]** and are the first thing to tune against real repos.

**Tarball decoding.** `DecompressionStream('gzip')` is native in Chrome — no gzip library. Tar
is a 512-byte-header format; a streaming parser is ~80 lines and lives in `core/archive`.
We stream, match each entry against the selection, keep matches, and discard the rest without
ever materialising the archive. Peak memory is bounded by the *selection*, not the repo.

**CORS.** `api.github.com` sends permissive CORS, but `codeload.github.com` does not. This does
not matter: MV3 service-worker fetches to hosts listed in `host_permissions` are not subject to
CORS. Therefore **all network calls originate in the background service worker**, never in the
popup or a content script. This is a correctness requirement, not a style preference.

**Rate-limit accounting.** Every response's `x-ratelimit-*` headers update a single observed
`RateLimit`. Before any multi-request operation, `core` computes the request cost and refuses to
start if it exceeds `remaining`, telling the user the cost and the reset time. We never discover
exhaustion halfway through a 100-page PR fetch.

## 4. Data flow per feature

**Tree picker.** popup → worker: `{tree, owner, repo, ref}` → `resolveRef` → cache lookup by
commit SHA → `getTree(recursive)` → `buildTree` → `applyRules` → structured-clone the tree to
the popup once. Every subsequent click is local: `toggle` + `totals`. Zero network per click.

**Budget.** On popup open, worker fires `probeOllama` (300ms timeout, one attempt) in parallel
with the tree fetch. Model list = static `MODELS` + probe results. `budget()` runs in the popup
on the already-local tree.

**Digest.** popup → worker: `{buildDigest, mode, selection, format}` → decision rule picks
tarball or blobs → stream + filter → redact → build IR → `render` → transfer the string back.
Progress events stream to the popup. `AbortSignal` wired to the cancel button.

**PR / compare.** Fetch `DiffFile[]` first (cheap, structured). If `includeFullFiles`, the set of
touched paths becomes the selection and the normal content path runs at the head SHA. Any cap
hit produces a `Truncation` that is rendered into the digest header *and* shown in the UI.

**Presets / history.** Pure `chrome.storage.local` reads and writes in the popup. No worker
involvement, nothing to sync.

## 5. Token counting without shipping a tokenizer

No tokenizer is shipped. Claude, Gemini, and Grok publish none; `o200k_base` is ~1–2 MB and
would only make one family accurate, which is worse than being uniformly and visibly approximate.

Estimator: `tokens ≈ bytes / cpt(extension, family)`, where `cpt` (characters per token) is a
small static table — roughly 3.6 for prose/markdown, 3.0 for most code, 2.6 for JSON and
minified output, 4.0 for plain English comments-heavy source (**[estimate]**; the table is
calibrated offline against a corpus and its constants are the only thing to re-tune). Families
get a multiplier; absent published tokenizers, all non-GPT multipliers are 1.0 until measured.

Three properties make this the right call:
- It needs only `size` from the tree, so per-file counts exist *before any content is fetched* —
  which is the only reason the live tree total is possible at all.
- Cost is O(1) per file. A 10k-file recompute is a sum over a subtree.
- Error is systematic and one-directional-ish, so a default 15% reserve absorbs it.

The UI never shows a bare number: every count is `~12.4k est.` with a tooltip naming the method
and the band. Accuracy claims we cannot back are worse than visible approximation.

Upgrade path, not v0.1: an optional lazily-fetched tokenizer WASM for exact GPT counts. It
requires `wasm-unsafe-eval` in the CSP and a >1 MB download, and buys accuracy for one family.
Deferred until users ask.

## 6. Caching

Commit SHAs are immutable, which makes caching trivial and correct.

| Key | Store | TTL |
|---|---|---|
| `tree:{owner}/{repo}@{commitSha}` | IndexedDB | none (immutable) |
| `blob:{sha}` | IndexedDB | none (immutable) |
| `tar:{owner}/{repo}@{commitSha}` | IndexedDB, only if <64 MB **[estimate]** | LRU, 512 MB cap |
| `ref:{owner}/{repo}/{ref} -> sha` | memory, worker lifetime | 60s |
| `ollama:probe` | memory | popup session |

`unlimitedStorage` permission; LRU eviction by last-access, evicting archives before blobs.
A ref→SHA resolve is 1 request and turns every later lookup into a cache hit, so it pays for
itself immediately.

## 7. chrome.storage schema

```ts
// chrome.storage.local
interface StorageV1 {
  schemaVersion: 1;
  auth?: { token: string; login: string; addedAt: number };   // PAT, plaintext, see §11
  settings: {
    defaultFormat: Format;
    defaultModelId: string;
    reserveRatio: number;          // 0..0.5
    redactSecrets: boolean;
    respectGitignore: boolean;
    ollamaEnabled: boolean;        // gates the probe entirely
  };
  presets: Record<string /* `${owner}/${repo}` */, Preset[]>;
  history: HistoryEntry[];         // max 20, FIFO
}
interface Preset { id: string; name: string; rules: Rules; overrides: Record<string, boolean>; modelId?: string; createdAt: number; }
interface HistoryEntry { id: string; repo: string; ref: string; mode: DigestMode['kind']; tokens: number; files: number; format: Format; selection: string[]; at: number; }
```

History stores the *selection*, never the digest body — a 500k-token digest does not belong in
extension storage. Re-run regenerates. Migrations key off `schemaVersion`.

## 8. MCP server

`npx gitscribe-mcp`. stdio transport. No key, no config file, no network beyond api.github.com.
Reads `GITHUB_TOKEN` from the environment if present; works without it. Roughly 300 lines: a
transport, a tool table, and `createGitHubClient({ fetch, now })` from `core`.

| Tool | Params | Returns |
|---|---|---|
| `gitscribe_tree` | `{ repo: "owner/name", ref?: string, depth?: number, rules?: Rules }` | `{ tree: string, files: number, bytes: number, tokens: number, truncated: boolean }` — an indented text tree with per-file token estimates. |
| `gitscribe_digest` | `{ repo, ref?, include?: string[], exclude?: string[], maxTokens?: number, format?: Format, redactSecrets?: boolean }` | `{ content: string, summary: {...}, truncations: Truncation[] }`. With `maxTokens`, the selection is trimmed by the same ranking as "Suggest cuts" and the trim is reported. |
| `gitscribe_diff` | `{ repo, pr?: number, base?: string, head?: string, includeFullFiles?: boolean, format?: Format }` | `{ content, summary, truncations }`. Exactly one of `pr` or `base`+`head`. |
| `gitscribe_estimate` | `{ repo, ref?, include?, exclude?, modelId?: string }` | `{ tokens, files, bytes, model?, fits?: boolean, overBy?: number }` — cheap, tree-only, no content fetch. |
| `gitscribe_models` | `{}` | `ModelInfo[]`, including Ollama models when reachable. |

`maxTokens` on `gitscribe_digest` matters more than it looks: it is the difference between an
agent getting a usable digest and an agent blowing its own context on the tool result.

## 9. MV3 permissions, CSP, performance

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage", "unlimitedStorage"],
  "host_permissions": [
    "https://api.github.com/*",
    "https://codeload.github.com/*",
    "https://objects.githubusercontent.com/*"   // tarball redirect target
  ],
  "optional_host_permissions": ["http://127.0.0.1:11434/*"],
  "content_scripts": [{ "matches": ["https://github.com/*"], "js": ["content.js"], "run_at": "document_idle" }],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src https://api.github.com https://codeload.github.com https://objects.githubusercontent.com http://127.0.0.1:11434"
  }
}
```

Not requested, deliberately: `tabs`, `<all_urls>`, `webRequest`, `cookies`, `scripting`. The
content script only reads `location.pathname` to detect repo/PR context and injects a button; it
performs no network calls and holds no token. Ollama is an *optional* host permission requested
at the moment the user enables local models, so the default install asks for nothing local.
Default MV3 CSP is kept — no remote code, no `wasm-unsafe-eval`, no eval.

**Performance budget, 10k-file repo** (all **[estimate]** until measured on a reference repo;
the benchmark ships in CI and these become regression gates):

| Step | Budget |
|---|---|
| `getTree` recursive (~2–4 MB JSON) | ≤2.5s cold, ~0 warm |
| `buildTree` + `applyRules` | ≤400ms |
| Structured clone worker→popup | ≤200ms |
| First paint of virtualized tree | ≤300ms |
| **Tree interactive, cold** | **≤8s** |
| `toggle` + `totals` after a click | **≤100ms** |
| Tarball download, 50 MB | network-bound; streamed, progress shown |
| Tar+gzip decode + filter, 50 MB | ≤6s |
| `render` markdown, 300k tokens | ≤1.5s |

Hard caps rather than hangs: refuse >150k tree entries, >1 GB tarball, >2M estimated tokens in
one digest, each with a labelled `Truncation`.

## 10. Secret redaction

On by default. Line-level regex over text files before they enter the IR: AWS keys, GitHub
tokens (`gh[pousr]_`), private key PEM blocks, `Bearer` headers, generic
`(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{12,}`. Matches are replaced with
`[GITSCRIBE-REDACTED:{rule}]` and recorded in `digest.redactions` so the user sees the count.
This reduces accidental secret exfiltration into a chat window; it is not a secret scanner and
is documented as such.

## 11. Threat model — the PAT

Asset: a user-supplied GitHub fine-grained PAT granting read access, possibly to private repos.
Stored plaintext in `chrome.storage.local`.

| Threat (STRIDE) | Vector | Mitigation |
|---|---|---|
| **Information disclosure** | Malicious webpage reads the token | `chrome.storage.local` is not reachable from page context. The content script never receives the token and never touches storage. |
| **Information disclosure** | Token exfiltrated to a third party | There is no third party. `connect-src` and `host_permissions` are an enforced allowlist of three GitHub hosts plus optional localhost; a request anywhere else is blocked by the platform, not by our code. This is the reviewable version of the trust claim. |
| **Information disclosure** | Token leaks into a digest, history entry, or error message | Token lives only in the `GitHubClient` closure. `Digest` and `HistoryEntry` have no field that can hold it. Error objects are constructed from status + endpoint path, never from request headers. Lint rule forbids `JSON.stringify` on anything carrying an auth header. |
| **Information disclosure** | Local machine compromise / another extension | Out of scope — `chrome.storage.local` is readable by anything with local file access. Stated plainly in the settings UI. Encrypting at rest would require a key stored beside it: theatre. Real mitigation is the *fine-grained, read-only, repo-scoped, expiring* token we tell the user to create, and one-click revoke. |
| **Spoofing** | Phishing page mimicking the settings screen | The token is entered only in the extension's own options page (`chrome-extension://` origin). We never accept a token from a message, a page, or a URL parameter. |
| **Elevation of privilege** | Over-scoped token | Setup copy asks for a fine-grained PAT with Contents: Read-only and an expiry, and names the specific repos. The UI displays the resolved scopes from `GET /user` so over-scoping is visible. |
| **Tampering** | Compromised extension update | Signed by the Chrome Web Store; source is public; the extension holds no permission that would let a malicious update reach anything but GitHub. |
| **Repudiation** | User cannot tell what the extension did | Every request is attributable to a user action; the rate-limit counter in the UI is a live, independent side-channel confirming request volume. |

Non-negotiables enforced in review: the token is never logged; never placed in a URL; never sent
to a host outside `host_permissions`; never persisted anywhere but `storage.auth`; and the
extension ships with zero analytics, so there is no pipe for it to leak into.
