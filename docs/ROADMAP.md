# GitScribe — Roadmap

Companion to `SPEC.md` and `ARCHITECTURE.md`. Durations are **[estimate]**, expressed in
engineer-weeks for one full-time engineer, and exist to force sequencing decisions, not to be
committed to a calendar.

## Sequencing principle

`core` is built first and stays ahead of both adapters. The extension and the MCP server are
thin; if either starts accumulating logic, that logic belongs in `core` and the milestone is
wrong. The single riskiest assumption — that a tarball can be streamed, decompressed, and
filtered inside an MV3 service worker — is retired in M0, before any UI exists.

---

## M0 — Spike: prove the hard parts (1 week)

Not shippable. Exists only to kill assumptions cheaply.

- Fetch `tarball/{ref}` from an MV3 service worker with `host_permissions`, follow the
  `codeload.github.com` redirect, and confirm CORS is genuinely bypassed. **If this fails, the
  whole content strategy changes to per-blob fetches and the rate-limit budget collapses — this
  is the single most important thing to learn in week 1.**
- `DecompressionStream('gzip')` + streaming tar parse over a real 50 MB repo; measure peak
  memory and decode time against the §9 budget.
- Recursive `git/trees` against a 10k-file repo and a known >100k-entry monorepo; confirm the
  `truncated` flag shape and measure JSON size and parse time.
- Calibrate the characters-per-token table against a corpus; record the actual error band so the
  UI's claimed band is real.

**Exit:** a written note with measured numbers replacing four of the `[estimate]` markers in
`ARCHITECTURE.md`, or a documented pivot.

## M1 — `core` (2 weeks)

GitHub client with rate-limit accounting and pre-flight cost refusal; tree build; rules and
selection algebra with incremental `toggle`; token estimator and model registry; tarball and
blob content paths plus the decision rule; digest IR and all four renderers; secret redaction.

Tested headlessly with recorded fixtures — no browser, no network in CI.

**Exit:** `buildDigest` produces a correct markdown digest for three reference repos from a
Node script, with every `Truncation` path exercised.

## M2 — v0.1 extension: ship it (3 weeks)

Scope is deliberately narrower than the full spec. The four features are *represented*, not
complete.

Ships:
- Popup with virtualized tree picker, checkboxes, per-file token estimates, live total. (S1, S2)
- Glob include/exclude applied over the visible tree; defaults for binary/generated/vendored.
- Model picker + budget bar + "Suggest cuts". Ollama discovery with graceful absence. (S3)
- Repo digest at any ref; export markdown / XML / JSON / text; copy and download. (S7)
- PAT settings with the full trust disclosure, `GET /user` validation, one-click revoke. (S8)
- Rate-limit counter and an actionable 403/429 path.
- MCP server with `gitscribe_tree`, `gitscribe_digest`, `gitscribe_estimate`, `gitscribe_models`.

Explicitly **not** in v0.1:
- PR / compare modes (M3) — the tree picker is the differentiator and must land first, whole.
- Presets and history (M3) — a preset that saves a half-designed rule model is worse than none.
- `gitscribe_diff` MCP tool (M3).
- Any non-GitHub host.
- Exact tokenization of any kind.

**Exit:** a stranger installs from the Web Store, digests a public repo with no account, and the
result fits their chosen model.

## M3 — v0.2: changes and memory (2 weeks)

- PR digest, commit range, branch compare, with honest truncation labelling at the 3,000-file
  and 300-file caps. (S4, S5)
- Compare-cap fallback: when a comparison exceeds 300 files, diff the head tree against the base
  tree ourselves for the path list, at a measured extra request cost.
- Presets per repo; history with one-click re-run; stale-override reporting. (S6)
- `gitscribe_diff`.
- Promote GPT / Gemini / Grok context windows from `estimate` to `vendor-docs` by reading each
  vendor's model documentation at build time, and add a CI check that fails when an entry's
  `verifiedOn` is older than 90 days.

## M4 — v0.3: sharpen (2 weeks, demand-gated)

Each item ships only if v0.1/v0.2 usage justifies it. Listed in priority order.

- Lazy-loaded tiktoken WASM for exact GPT counts, behind a setting, with the CSP change it
  requires. Only if users complain about estimate accuracy, not before.
- GitLab support via its REST API — a second `GitHubClient` implementation behind the same
  interface. Bitbucket after, on the same evidence bar.
- Firefox build (WXT makes this near-free; verify `DecompressionStream` and service-worker CORS
  behaviour, which are the two things that differ).
- `.gitscribe.json` in-repo config so a maintainer can ship a default selection with their repo.

## Risks

| # | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Tarball fetch from the service worker is blocked** (redirect host, CORS, or a Chrome change). | Critical — content strategy collapses to N blob requests, making the anonymous 60/hr tier nearly useless for real repos. | Low–medium | Retired in M0, week 1. Fallback already specified: per-blob fetches plus a much more aggressive default exclusion set and a prominent "add a PAT" prompt. |
| R2 | **Anonymous 60 req/hr is exhausted before the user's first click**, because the limit is per source IP and corporate NAT shares it. | High — the no-key promise silently fails for exactly the enterprise users who most need the no-backend story. | Medium | The tree costs 1 request and the tarball 1, so the happy path is 2–3 requests, not 30. Rate-limit counter is visible from the first render. 403 handling names the reset time and offers the PAT path in one click. |
| R3 | **Token estimates are wrong enough to break trust** — a "fits" digest gets rejected by the model. | High — the budget bar is the product's core claim. | Medium | Never show a bare number; always `~Nk est.` with the method and band. Default 15% reserve. Calibrate in M0 with a measured band and publish it. Bias the estimator to over-count: predicting too many tokens is a recoverable annoyance, predicting too few is a broken promise. |
| R4 | **Large monorepos break the tree.** >100k entries or >7 MB truncates the recursive trees call. | Medium | Medium | `truncated` is propagated to the UI verbatim, not swallowed. Lazy per-directory expansion path built in M1, not bolted on later. Hard cap at 150k entries with a labelled truncation instead of a hang. |
| R5 | **Memory blowup on a large repo in a service worker**, causing a silent worker kill mid-digest. | Medium–high — a killed worker looks like a hang, which is worse than an error. | Medium | Never materialise the archive; stream and filter, so peak memory tracks the selection not the repo. Hard caps at 1 GB archive and 2M estimated tokens. Worker sends a heartbeat; the popup surfaces "worker died" explicitly rather than spinning. |
| R6 | **Chrome Web Store review flags the permission set**, particularly the localhost host permission. | Medium — blocks distribution. | Low–medium | Ollama is an *optional* host permission requested at enable time, so the default install does not carry it. Three narrow GitHub hosts, no `<all_urls>`, no `tabs`, no analytics. Store listing states the zero-backend architecture up front; a reviewer can verify it from the permission list alone. |
| R7 | **Context-window numbers go stale.** Model releases outpace releases of a static registry. | Medium — a wrong window produces a confidently wrong "fits". | High | Ollama is read from the runtime and is always right. For hosted models, `windowSource` and `verifiedOn` are required fields, the UI shows them, and CI fails a build whose vendor-verified entry is over 90 days old. A visibly dated number beats a silently wrong one. |
| R8 | **PR/compare caps disappoint on exactly the large PRs people most want digested.** | Medium | High for large-refactor PRs | Truncation is a first-class field in the digest and a visible banner in the UI, never a silent omission. M3 adds the tree-diff fallback for the 300-file compare cap. |
| R9 | **Scope creep into a backend.** The first "just a tiny proxy for X" ends the product's only durable differentiator. | Existential | Medium | The constraint is architectural, not a preference: `core` has no server client and `host_permissions` is an enforced allowlist. Any proposal requiring a new host is a spec change reviewed against §6 of `SPEC.md`, not an implementation detail. |
| R10 | **gitingest closes the tree-UX gap.** | Medium | Low–medium | Their architecture makes the live tree expensive — they would have to ship the tree to the client, at which point they are paying for a backend we do not have. Our moat is the absent server, not the checkbox. |
