# GitScribe

Turn a **GitHub or GitLab** repository into an LLM-ready digest — or have a
model write a **README that maps the whole codebase**, so a model answering
questions about it can find things fast.

A Chrome side panel and an MCP server, sharing one core. No backend, no account.

## Two modes, and they have different privacy stories

| | Raw digest | Generated README |
|---|---|---|
| What it does | Concatenates the files you select | A model reads the code and writes documentation |
| Needs an API key | No | **Yes** (or a local Ollama model) |
| Costs money | No | **Yes**, per run — shown before you commit |
| Your code leaves the machine | **No** | **Yes — to the provider you choose** |
| Output is | Exact, deterministic | Model-generated, and can be wrong |

Read that third row twice. Everything else in GitScribe keeps your code on your
machine. **Generating a README cannot** — the model has to see the code. Pick
Ollama for the analysis pass if that matters to you; it runs locally and is free.

## What it is honestly

- **No server of ours exists.** Network calls go to `api.github.com`,
  `gitlab.com` (or your own GitLab host), Ollama on `127.0.0.1` if you run one,
  and — for README generation or exact token counts — the model provider you
  chose. There is nothing of ours to collect data with, and no analytics or
  telemetry.
- **Models invent files, so the output is checked.** Every path the generated
  README mentions is compared against the files actually read; anything that
  does not exist is listed under **Unverified references** rather than left to
  look authoritative. This is not hypothetical — a local model described
  `slugify` as a Jest suite with four test files that do not exist.
- **It does not work offline.** Reading a repository needs the network.
  Caching is in-memory in the background worker only, so it does **not** survive
  a worker restart, and there is currently **no durable offline reopen**.
  (An earlier version of this file implied otherwise; that was wrong. Durable
  artifacts are IMP-06 in `imp.md`, not yet built.)
- **Token counts are estimates by default**, deliberately biased to over-count
  so a digest reported as fitting is not then rejected for length. Two ways to
  get exact numbers: locally-served Ollama windows are read from the running
  server, and adding an Anthropic or Google key lets you ask that vendor to
  count a digest exactly, on demand. **OpenAI publishes no counting endpoint and
  xAI's is unconfirmed**, so those stay estimated no matter what key you add — a
  key cannot buy what the vendor does not offer.
- **Nothing selected is ever dropped silently.** Every file in the *selection*
  is either in the output or named in a truncation record. That is a different
  claim from "we read the whole repository": when a host truncates its own
  listing, files are **undiscovered** and cannot be named at all. The two are
  reported separately and never merged into a single "nothing missing" claim.
- **Secrets are redacted by default**, and what was redacted is reported.

## Layout

```
packages/core        pure TS, no DOM and no node builtins — shared by both
packages/extension   MV3 side panel
packages/mcp         stdio MCP server, runs via npx
```

GitHub and GitLab are **not** symmetric, and the code does not pretend they are:

| | GitHub | GitLab |
|---|---|---|
| File sizes before download | Yes — the trees API returns `size` | **No** — its tree API returns no size at all |
| How the tree is built | One recursive trees call | By streaming the archive and reading tar headers |
| Whole repo costs | 2 requests | 1 archive download |
| Anonymous limit | 60/hour per IP | 500/min API, but archives are shaped separately |
| Throttle signal | 403 with `x-ratelimit-remaining: 0` | **406 Not Acceptable** |

**GitLab throttles archive downloads on a budget separate from its API, and a
token does not lift it.** You can hold 2,000 API requests a minute and still be
refused the archive with `406 Not Acceptable`. When that happens GitScribe:

- lists the tree through the API instead (pages loaded in parallel; 1,701
  files in about 4 seconds), and fills in the **file sizes** the tree API
  leaves out from GitLab's GraphQL API, 90 paths per query, and
- reads the selected files individually through the `raw` endpoint, six at a
  time.

That costs one request per file and is disclosed in the digest and in the
estimate. Measured on `gitlab-org/gitlab-runner`: 277 files in **22 seconds**,
using 277 of the 500 requests-per-minute budget.

**GitLab's anonymous GraphQL allowance is small.** Measured: a few loads of a
1,700-file repository exhausted it, followed by a 15–40 minute `429`. When that
happens sizes are shown as unknown (`?`), never as zero, and the panel and MCP
tools say why and for how long; building the digest still gives real counts.
Whether a GitLab token raises that allowance has not been measured.

Core reaches its environment only through an injected `Env { fetch, now }`,
which is why one package serves both an MV3 service worker and a Node process
with no compatibility layer.

## Build

```bash
npm install
npm run build -w @gitscribe/core
npm test                              # core + extension + MCP contract, no network
npm run build -w @gitscribe/extension
npx tsc -p packages/mcp/tsconfig.json
```

## Load the extension

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `packages/extension/dist`
3. Open any GitHub repository and click the GitScribe toolbar icon.

The panel opens docked, at full height, and **persists while you browse** —
your selection survives navigating around the repo, which a popup cannot do.

**Diagnostics** (gear → Run diagnostics) re-checks the assumption everything
rests on: that a tarball fetch from the background service worker follows the
`api.github.com` → `codeload.github.com` redirect and is exempt from CORS.
This has been **confirmed inside a real MV3 service worker** — see
`docs/MEASUREMENTS.md`. Worth re-running if Chrome changes its redirect or CORS
behaviour.

## MCP server

```json
{
  "mcpServers": {
    "gitscribe": {
      "command": "node",
      "args": ["/absolute/path/to/gitscribe/packages/mcp/dist/server.js"]
    }
  }
}
```

`repo` accepts `owner/repo`, a github.com or gitlab.com URL, a self-managed
GitLab URL, or `gitlab:group/sub/project`. `GITHUB_TOKEN` is optional and only
raises GitHub's rate limit; `GITLAB_TOKEN` is optional and reaches private
GitLab projects. `gitscribe_diff` takes a GitHub pull request, a GitLab merge
request (`!123` or its URL), or a commit range on either host. If GitLab's file
sizes are unavailable, `gitscribe_estimate` and `gitscribe_plan_parts` refuse
rather than report a false "fits", and say why; `gitscribe_digest` still works.

| Tool | Does |
|---|---|
| `gitscribe_tree` | Every file with size and estimated token cost. 1–2 requests. |
| `gitscribe_digest` | Fetch and render. Redacts secrets, reports truncations. |
| `gitscribe_estimate` | Fits-or-not against a model, from the tree alone — no content downloaded. |
| `gitscribe_plan_parts` | How many parts a repo needs at a token budget, computed from the tree — no content downloaded. |
| `gitscribe_diff` | Digest a PR, commit range, or branch comparison, with the caps reported. |
| `gitscribe_readme_guide` | The workflow and exact prompts for writing a navigable README. Start here. |
| `gitscribe_readme_chunk` | One context-sized part of the repo with analysis instructions. Call once per part. |
| `gitscribe_verify_readme` | Checks every path a document claims against the real files and reports invented ones. |
| `gitscribe_diagram` | Architecture diagram as Mermaid; every arrow is a real import. Optional labels you supply are checked against the code. |
| `gitscribe_snapshot` | Write a repo (pinned to a commit) into a local folder: redacted text, small images, and `.gitscribe/` facts. Env files and keys are never written. |
| `gitscribe_models` | Known windows with provenance, plus discovered Ollama models. |

### Promo video from a URL (`/brag` bridge)

The server also registers a prompt, so Claude Code shows
`/mcp__gitscribe__promo <repo> [tone]`. It snapshots the repository with
`gitscribe_snapshot` and runs the [brag](https://github.com/latent-spaces/brag)
skill on that folder — no clone needed, private repos work with a token. brag
and HyperFrames do the creative work and rendering; GitScribe adds
`.gitscribe/facts.md`, `tour.json` and `architecture.mmd`, and brag is told any
"how it's built" claim must come from those. Requires the brag plugin and its
HyperFrames/ffmpeg toolchain to be installed.

## Rate limits

Anonymous GitHub allows **60 requests an hour, per IP address** — on an office
network it can be spent before your first click. A whole-repository digest
costs **2 requests** (tree + tarball), which is what keeps that tier usable.
A fine-grained token with `Contents: read` raises it to 5,000/hour and allows
private repositories. It is stored in `chrome.storage.local` and sent only to
`api.github.com`.

## Generating a README

1. Open a repository, pick your files in the tree.
2. Settings (gear) → choose an **analysis model** and a **synthesis model**, and
   save a key for each provider.
3. **Generate README** — this *prepares* a plan. Nothing is sent and nothing is
   spent yet.
4. Review the plan: repository and commit, file count, both models, call count,
   estimated **and worst-case** cost, and exactly which providers receive your
   code or your code-derived notes.
5. **Send and generate**, or Cancel. Changing the selection or either model
   invalidates the plan and you prepare it again.

Two models because the work is two different jobs. Analysis reads every chunk of
code — bulk work, where a cheap fast model is usually right. Synthesis writes the
final document from those notes — one call, and where quality shows. They are
configured independently; use Ollama for analysis and a frontier model for
synthesis if you want most of the code to stay local.

Request sizes are derived from the **chosen model's** context window, not a
fixed constant: a 32k local model gets a ~26k allowance, a 200k model gets
~177k. If a model's window is unknown, generation is **blocked** with an
explanation rather than defaulted to a guess. When notes exceed what the
synthesis model can hold, they are condensed in bounded stages first.

The plan shows each model's window and where it came from (vendor docs,
measured from Ollama, entered by you, or approximate). A window you enter in
Settings is used for any model without a verified one.

**Ollama:** GitScribe sets Ollama's context size on every request. Without it,
Ollama uses a small default and silently drops most of a long prompt (measured:
10,781 tokens of code sent, 5,222 read). Verified end to end with
`qwen2.5-coder` (7.6B, local) on
`sindresorhus/slugify`: 2 calls, about 2.5 minutes, 11,870 tokens read, 13 file
references verified.

Cost is shown only where the provider publishes rates we have verified —
otherwise it says unknown rather than inventing a figure. Both an estimate and
a worst case are shown, because the worst case uses the output maxima actually
requested. Cancelling after a call is submitted may still incur charges; no
client-side figure is a billing cap.

The document carries its own caveats: a **Coverage gaps** section for anything
that could not be read, **Unverified references** for paths that do not exist,
and a footer naming the models used.

## Diagram

The **Diagram** tab draws which file imports which, for JS/TS and HTML
(`<script src>`). It is built from the code itself, locally and for free:

- **Every arrow is an import that exists.** Nothing is inferred from file names.
  Imports that cannot be resolved (path aliases such as `@/x`, files outside the
  selection) are listed under the diagram, not guessed. Packages are listed, not drawn.
- **Small repos get one box per file.** Past 40 files, folders are grouped and the
  busiest ones are opened back up to fill a 40-box budget; click a grouped folder
  to see its files. Click a file to open it on GitHub/GitLab at the pinned commit.
- **Label with AI** (optional) asks your Synthesis model for plain-English names.
  It is sent the outline only — paths, imports, exported names, each file's first
  comment, **never code** — and shows you that, and the destination, before
  sending. Any box, folder or connection the model invents is dropped and listed.
  Labels are kept for the browser session.
- Export as Mermaid (renders in GitHub READMEs), SVG or PNG.

Known limit: imports are found by pattern matching, not a full parser, so an
`import` written inside a string or comment can rarely produce a false arrow.

## Walkthrough video

**Make video** in the Diagram tab turns the diagram into an MP4 tour, rendered
inside the extension — no ffmpeg, no upload:

- **Onboarding** (60–90 s, 16:9) or **Share** (20–30 s, 9:16 or 1:1, opens with a hook).
- The tour starts where the code starts (the files nothing imports) and follows
  the real arrows. Captions come from the code, or optionally from your Synthesis
  model, which is sent the outline and stop list — never code. A model-written
  stop, arrow or file name that is not in the code is cut and listed.
- **Preview** plays it in the panel; **Render MP4** encodes frame by frame with
  WebCodecs (H.264, 30 fps), faster than real time — a 68-second tour of a
  46-file repo renders in about 11 seconds. Falls back to WebM where H.264 is
  unavailable. The panel must stay open while rendering.

Each video carries a soundtrack generated in the browser (a calm C-major
progression with a note per stop), mixed to about -16 LUFS. No voiceover.

## Repositories too large for one context window

Nothing is left out — the digest is split instead. Turn on **Split to fit** in
the Output pane, or pass `maxTokens` to `gitscribe_digest`. Each part states its
position ("Part 3 of 12"), lists what every other part holds, and repeats the
incompleteness notices, so a model reading one part cannot mistake it for the
whole repository. Parts are contiguous slices in path order, so directories stay
together. A single file larger than the budget gets its own part and is flagged
rather than cut in half.

## Caps that make "complete" impossible, and are reported rather than hidden

- Recursive trees truncates at **100,000 entries or 7MB** — and the byte cap
  bites first: `rust-lang/rust` truncated at **60,079 blobs**. See
  `docs/MEASUREMENTS.md`.
- `compare` returns at most **300 changed files**, with no pagination.
- `pulls/:n/files` caps at **3,000 files**.

## Measured, not guessed

`docs/MEASUREMENTS.md` carries real numbers — throughput, memory, and the
GitLab throttling behaviour — and says plainly which claims are still
unmeasured.

## Honest status against `imp.md`

`imp.md` assesses this at ~7/10 and specifies 15 work items over 9–13
engineer-weeks. **Phase A (the P0 set) is implemented and verified**; the rest
is not. Do not read the feature list as a 9/10 claim.

| Item | State |
|---|---|
| IMP-01 immutable snapshots | **Done** — refs resolve to a commit; caches keyed by commit + origin |
| IMP-02 explicit ids | **Done** — `digestId`/`jobId`; no `lastDigest` global |
| IMP-03 model-aware budgets | **Done** — no fixed 120k; unknown capacity blocks; staged reduction |
| IMP-04 reviewable plan | **Done** — prepare/start split, destinations and worst case shown |
| IMP-05 truthful claims | **Done for docs** — coverage categories partly done |
| IMP-06 durable artifacts | **Not started** — history still re-fetches; no IndexedDB |
| IMP-07 resumable jobs | **Partial** — cancel/keepalive exist; no persistence or resume |
| IMP-08 evidence-backed README | **Partial** — grounding + denominator fixed; no evidence spans |
| IMP-09 token calibration | **Not started** — no measured corpus; margins are unvalidated |
| IMP-10 memory safety | **Partial** — oversize now refused from the tar header, before allocation |
| IMP-11 PR/diff in panel | **Done** — Changes mode, GitHub PRs and GitLab MRs, plus commit ranges |
| IMP-12 permissions | **Done** — `tabs` replaced by GitHub/GitLab host access (measured); providers optional |
| IMP-13 selection/a11y | **Not started** |
| IMP-14 model registry | **Done** — one registry (`core/registry.ts`); fit checks, budgets and prices all derive from it |
| IMP-15 reproducible tests | **Mostly done** — clean test builds, MCP contract test, root command |

## Not built yet

- Exact GPT counts (needs tiktoken bundled locally, ~1MB — a key does not help).
- Bitbucket, and any other host.
