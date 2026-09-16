# GitScribe — Product Spec

Status: draft v0.1 · Owner: Principal PM-Architect · Date: 2026-09-16

## 1. Problem

Getting a repo into an LLM is still manual. People either paste files one at a time, run a CLI
and lose the output, or use gitingest — which is one button that returns the whole repo as one
blob. None of these let you answer the only question that matters in practice: *which subset of
this repo fits in my model's context window, and what is it costing me?*

The failure mode is specific. You paste a 400k-token digest into a 200k-context model, it gets
silently truncated or rejected, and you go back to guessing. The tool that wins is the one that
makes selection and budget a first-class, visible, interactive act — not a post-hoc surprise.

## 2. The competitor and the gaps we exploit

`coderamp-labs/gitingest-extension` (WXT + Tailwind + TS) is a thin client over the
gitingest.com backend. It adds a GitHub button and a popup showing file count, size, and an
estimated token count, then hands off to the hosted service. The upstream engine
(`coderamp-labs/gitingest`) clones server-side, applies `.gitignore` plus include/exclude
glob patterns, and emits summary + directory tree + concatenated file contents, with token
counts estimated via `tiktoken`.

Gaps, in order of exploitability:

| # | Gap | Why it exists | What we do |
|---|---|---|---|
| G1 | **Tree UX is a text box.** Include/exclude are typed glob strings; you cannot see what a pattern selected until after you run it. | The tree lives server-side; the extension never has it. | We fetch the tree ourselves. Live checkbox tree, per-file token counts, patterns as *rules applied to a visible selection*. |
| G2 | **Token count arrives after the fact**, as a single number with no target. | No model targeting in the product. | Budget bar against a chosen model's context window, updating on every checkbox. |
| G3 | **HEAD of default branch only.** No PR, no diff, no branch comparison. | The clone-and-flatten model has no notion of a change set. | First-class PR / commit-range / branch-compare digests. |
| G4 | **Nothing persists.** No presets, no history, no re-run. | Stateless service; extension stores nothing meaningful. | Per-repo saved profiles, recent digests, one-click re-run. |
| G5 | **Your private code goes to someone else's server.** Private repos require handing a PAT to a third party. | Architecture requires a backend. | Zero backend. Code never leaves the machine. This is the trust story, not a footnote. |
| G6 | **Service availability and quota are theirs.** | Hosted. | Only dependency is api.github.com, which you were already using. |

Where they are ahead, and we accept it: gitingest supports any Git host and arbitrary clone
URLs, and produces a shareable link. We can do neither without a backend (§6, §7).

### Competitive table

| Capability | gitingest-extension | GitScribe v0.1 |
|---|---|---|
| Works with no account / no key | Yes | Yes (anonymous GitHub API) |
| Backend dependency | gitingest.com | None |
| Private repos | PAT sent to gitingest | PAT never leaves the browser → api.github.com only |
| Interactive file tree | No | Yes — checkboxes, per-file tokens, live total |
| Glob include/exclude | Yes (text field) | Yes, applied live over a visible tree |
| Token count | Post-hoc estimate (tiktoken) | Live estimate, per file and total |
| Model targeting / budget bar | No | Yes — Claude, GPT, Gemini, Grok, local Ollama |
| Local Ollama model discovery | No | Yes (127.0.0.1:11434) |
| PR / diff / branch digest | No | Yes |
| Presets per repo | No | Yes |
| History + one-click re-run | No | Yes |
| Export formats | Text | Markdown, XML, JSON, plain text |
| MCP server | No | Yes (`npx`, stdio, no key) |
| Non-GitHub hosts | Yes | No (v0.1) — see Non-goals |
| Shareable digest URL | Yes | No — by construction |

## 3. Users and stories

**P1 — Staff engineer onboarding onto an unfamiliar service.** Wants the 30 files that matter,
not 3,000.

**P2 — Reviewer.** Wants a PR's diff plus the touched files' full contents, as one prompt.

**P3 — Local-model user.** Runs Ollama, has 32k of context, needs to know what fits.

**P4 — Engineer at a company that forbids pasting code into third-party services.**

### Stories and acceptance criteria

**S1 — Digest a repo without signing in**
As P1, on any public GitHub repo page, I click the GitScribe icon and get a digest.
- AC1: Popup opens with the repo's tree rendered, no auth prompt, no onboarding wall.
- AC2: For a repo ≤5k files, tree is interactive within 3s on a warm cache, 8s cold (estimate; see ARCHITECTURE §9 for the budget and where it is measured).
- AC3: Remaining anonymous rate-limit budget is shown as `n/60 this hour`, sourced from response headers, never guessed.
- AC4: On HTTP 403/429 with `x-ratelimit-remaining: 0`, the UI shows the exact reset time from `x-ratelimit-reset` and a one-click path to add a PAT. It does not say "try again later".

**S2 — Select a subset and see the cost**
As P1, I check and uncheck directories and watch the total.
- AC1: Toggling a directory toggles all descendants; parent shows indeterminate state when partially selected.
- AC2: Total token estimate updates in <100ms for a 10k-file tree (no refetch, no full recompute — see ARCHITECTURE §5).
- AC3: Every token number in the UI carries an "est." affordance; hovering explains the estimator and its expected error band.
- AC4: Binary, generated, and vendored files are excluded by default and shown greyed with the reason.

**S3 — Fit a target model**
As P3, I pick a model and get told what to drop.
- AC1: Model picker lists Claude / GPT / Gemini / Grok families plus any model returned by a reachable local Ollama.
- AC2: If Ollama is not running, the group is absent and a single inline line explains why — no error toast, no retry storm. One probe per popup open, 300ms timeout.
- AC3: Budget bar shows `selected / context window`, turns amber at 70% and red at 100%.
- AC4: Over budget, "Suggest cuts" proposes an ordered list of removals (largest-token, lowest-signal first) that brings the selection under budget, as a preview the user applies or rejects.
- AC5: Context-window values sourced from vendor docs are marked verified; everything else is marked as an estimate with its source date (see §8).

**S4 — Digest a PR**
As P2, on a PR page, I get the diff plus full contents of touched files.
- AC1: Extension detects `/pull/{n}` and defaults the mode to PR.
- AC2: Output contains per-file unified patches plus, optionally, post-merge full contents of touched files.
- AC3: If the PR exceeds GitHub's caps (3,000 files via the PR files endpoint; 300 files via compare), the digest is still produced and is explicitly labelled truncated, naming the cap hit and the count omitted. Silent truncation is a P0 bug.

**S5 — Branch / commit-range digest**
As P2, I enter `main...feature/x` or two SHAs.
- AC1: Accepts `base...head`, `base..head`, branch names, tags, and SHAs.
- AC2: Same truncation labelling as S4 (compare caps changed files at 300 for the whole comparison).

**S6 — Save and re-run a preset**
As P1, I save my selection for this repo and re-run it next week.
- AC1: A preset stores include/exclude rules and explicit per-path overrides, scoped to `owner/repo`.
- AC2: Re-run resolves rules against the *current* tree; files added since are picked up by rules, and paths that disappeared are reported, not silently dropped.
- AC3: History shows the last 20 digests with repo, ref, mode, token count, and timestamp; each re-runnable in one click.

**S7 — Export**
- AC1: Markdown, XML, JSON, and plain text, from the same digest, no refetch.
- AC2: Copy to clipboard and download to file. Digests over 5 MB skip clipboard and go straight to download (Chrome clipboard writes of that size are unreliable — estimate, to be measured).

**S8 — Add a token**
As P4, I paste a fine-grained PAT and understand exactly what happens to it.
- AC1: Settings states, in the UI and not only in the docs: stored in `chrome.storage.local`, sent only to `api.github.com` and its redirect targets, never to any GitScribe-operated endpoint (there are none).
- AC2: The extension's `host_permissions` are listed in the same screen, so the claim is checkable.
- AC3: Token is validated by a single `GET /user` call; the resulting scopes and rate limit are displayed.
- AC4: One-click revoke — clears storage and deep-links to GitHub's token settings page.
- AC5: The token is never written to the digest, to history, or to any log or error report.

## 4. Feature detail

### 4.1 Interactive file-tree picker (headline)

The tree comes from one recursive `git/trees` call, giving path, type, size, and blob SHA for
every entry. Contents are not fetched until digest time, so the tree is cheap and instant.

- Virtualized list; only the visible window renders. A 10k-file repo must scroll at 60fps.
- Per-file token estimate is derived from `size` (bytes) and the path's extension — available
  before any content is downloaded. This is what makes the live total possible at all.
- Three selection layers, composed in order: (1) built-in defaults (binary, lockfiles, minified,
  `node_modules`, `dist`, `.git`); (2) user glob rules, include and exclude; (3) explicit
  per-path clicks, which always win. The UI shows which layer decided each file.
- `.gitignore` is honoured by default when the repo's ignore files are available; toggleable.
- Search filters the tree by path substring or glob and offers "select all matches".

### 4.2 Token budget + model targeting

- Registry of models with `{ id, family, contextWindow, source, verifiedOn }`. Anything not
  read from vendor documentation is flagged in the UI as an estimate, with its date.
- Claude context windows are vendor-verified: Opus 5 (`claude-opus-5`) 1M, Sonnet 5
  (`claude-sonnet-5`) 1M, Haiku 4.5 (`claude-haiku-4-5`) 200K.
- GPT, Gemini, and Grok entries in v0.1 are populated from secondary sources and are therefore
  **marked as estimates in the UI**. Promoting them to verified requires reading each vendor's
  model docs at build time; that is a v0.2 chore, not a blocker.
- Ollama models are discovered from `GET 127.0.0.1:11434/api/tags`; the context length comes
  from `GET /api/show` per model, which reports the model's actual configured context. This is
  the one family where the window is read from the runtime rather than a table, so it is exact.
- Budget bar renders selected estimate against window, with a reserve slider (default 15%)
  for the user's own prompt and the model's response.
- "Suggest cuts" ranks candidates by tokens-per-unit-signal: generated/vendored first, then
  tests, then large leaf files, then files far from the user's search terms. It is a preview,
  never an automatic mutation.

### 4.3 PR / diff / branch digest

Three modes on top of the same renderer:
- **PR** — metadata (title, body, author, base/head) + per-file patches, optionally plus full
  contents of touched files at head.
- **Commit range** — `base...head` via compare.
- **Branch compare** — same machinery, branch names resolved to SHAs first.

Every mode emits an explicit `truncation` record in the digest header when a GitHub cap is hit.

### 4.4 Presets & history

- Presets are `{ id, repo, name, rules, overrides, model, createdAt }` in `chrome.storage.local`.
  Rules are portable across refs; overrides are path-pinned and may go stale by design.
- History stores digest *metadata plus the selection*, never the digest body (size). Re-run
  regenerates. Cap 20 entries, FIFO.
- Export writers are pure functions over one digest IR: Markdown (default), XML (tag-delimited
  per file, best for Claude), JSON (machine-readable, for the MCP path), plain text.

## 5. Non-goals (v0.1)

- Non-GitHub hosts. GitLab and Bitbucket are v0.3 candidates via their REST APIs; arbitrary
  `git clone` URLs are permanently out (§6).
- Shareable hosted links. Structurally impossible; we ship files and clipboard instead.
- Any analytics, telemetry, or crash reporting that leaves the machine.
- Semantic ranking, embeddings, or summarization of repo content. No model calls from us.
- Repo-wide grep over files we have not downloaded. GitHub's code search API requires auth and
  is separately rate-limited; it is not worth the budget in v0.1.
- Writing to GitHub. Read-only, always.

## 6. Flagged: genuinely infeasible or hard-capped without a backend

Listed because the cost of discovering these in week 6 is much higher than in week 0.

1. **Exact token counts for Claude, Gemini, and Grok are impossible.** None publish a
   tokenizer. Anthropic's `count_tokens` endpoint would require an Anthropic API key and a
   network call to `api.anthropic.com`, which violates the no-backend/no-key constraint.
   OpenAI's `o200k_base` is public but shipping it is ~1–2 MB and only fixes one family.
   **Decision: estimate everywhere, label everywhere, be honest about the error band.** This is
   not a temporary shortcut; it is the permanent state of the product absent a key.
2. **Arbitrary `git clone` URLs cannot work.** Git's smart-HTTP protocol plus packfile decoding
   in a service worker is technically possible and practically absurd, and every non-GitHub
   host would need to send permissive CORS headers, which they do not. Host support means
   per-host REST integrations, one at a time.
3. **Compare is hard-capped at 300 changed files**, with no pagination for the file list
   (verified: GitHub REST docs, "Compare two commits"). A 400-file refactor branch cannot be
   fully digested through that endpoint. Partial mitigation: fall back to fetching the head
   tree and diffing the touched paths ourselves, at N extra requests.
4. **PR files cap at 3,000** (verified: GitHub REST docs, "List pull requests files"),
   30 per page — a 3,000-file PR costs 100 requests, which is the entire anonymous hourly
   budget for one PR.
5. **Anonymous 60 req/hr is per source IP** (verified: GitHub REST rate-limit docs). Behind a
   corporate NAT the shared pool may already be exhausted before the user's first click. The
   PAT path is therefore not a nice-to-have upsell; for a meaningful share of users it is the
   only working path, and the UX must surface it at the moment of failure.
6. **Very large repos will not fully digest in a browser tab.** The recursive trees endpoint
   truncates past 100,000 entries or 7 MB (verified: GitHub REST docs, "Get a tree"), and the
   tarball path is bounded by browser memory. We cap and label rather than hang.
7. **No shareable digest URL.** There is nowhere to put it.

## 7. Success metrics

Measured locally and shown only to the user (no telemetry leaves the machine); reported in
aggregate only from voluntary user-submitted diagnostics.

- **Activation:** user reaches a copied or downloaded digest on first session, no PAT required.
  Target ≥70% (estimate; no baseline exists yet).
- **Selection engagement:** ≥40% of digests involve at least one manual tree interaction. If
  this is low, the headline feature is decoration.
- **Budget fit:** ≥90% of digests produced while a model is targeted come in under that model's
  window. This is the number the product exists to move.
- **Re-run rate:** ≥25% of digests originate from a preset or history entry by week 4.
- **Rate-limit dead ends:** <5% of sessions terminate on a 403/429 with no digest produced.
- **Perf:** tree interactive in <8s cold for a 10k-file repo; selection recompute <100ms
  (both estimates until measured — see ARCHITECTURE §9).
