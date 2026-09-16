# Feature audit — claims we can and cannot make

Checked against the gitingest-extension marketing copy. Two of its claims are
false for GitScribe, and one is false for gitingest too. We do not repeat them.

| Claim | Verdict | Detail |
|---|---|---|
| One-click access, integrated with GitHub's interface | **Yes** | Side panel (`chrome.sidePanel`), opens on the action click, plus a content-script entry point on repo pages. The panel persists across navigation, which a popup cannot do. |
| Smart formatting for LLM prompts | **Yes** | Four renderers (markdown / XML / JSON / plain). Markdown fences are computed per file so content containing backticks cannot break the fence; XML neutralises `]]>` in content. Both are covered by tests. |
| Customizable — "use the default GitIngest service or configure your own" | **No, and deliberately** | There is no service. GitScribe has no backend, so there is no endpoint to point anywhere. What *is* customizable: include/exclude globs, per-repo presets, output format, target model, token reserve, optional PAT. If a configurable remote endpoint is genuinely wanted, that is a different product with a different threat model — say so and we will scope it. |
| Privacy-first — zero data collection | **Yes, for us — but read on** | No server of ours exists to collect anything; no analytics, no telemetry; tokens live in `chrome.storage.local` and go only to the host they belong to. **However**, README generation sends repository content to the model provider the user picks. That is disclosed in the settings pane before the first run, and Ollama keeps it local. The raw digest mode still sends code nowhere. |
| …"works completely offline" | **No — this is false** | Reading a repository requires network access to `api.github.com`. It is false for gitingest as well; their extension calls their backend. What is true offline: re-reading and re-exporting a **cached** digest (cache is keyed by immutable commit SHA, so it never goes stale). We will say that, not "works offline". |
| Open source, community-driven | **Yes** | A licensing and process choice, free to make. |

## The four differentiating features

| Feature | Status |
|---|---|
| Interactive file-tree picker with per-file token counts | **Shipped.** Virtualized (a few dozen DOM nodes at any repo size), custom include/exclude rules, per-file costs from the trees API `size` field. GitLab has no sizes in its tree API, so there they come from the archive. |
| Token budget + model targeting (incl. Grok and local Ollama) | **Shipped.** Ollama windows read from `/api/show` and exact; others carry `windowSource` + `verifiedOn`, CI-checked for staleness. Optional Anthropic/Google keys give exact counts on demand. |
| PR / commit-range / branch-compare digest | **Shipped** in core and MCP (`gitscribe_diff`); caps reported explicitly. Not yet surfaced in the panel UI. |
| Presets & history | **Shipped.** Per-repo presets, 20-entry history, one-click re-open. |
| Chunking for oversized repositories | **Shipped.** `renderParts` / `gitscribe_plan_parts`; nothing dropped, each part self-describing. |
| GitLab support | **Shipped**, with the asymmetries documented rather than papered over. |
| LLM-generated README | **Shipped.** Map-reduce over chunks, independently chosen analysis and synthesis models, cost shown before spending, output grounding-checked against the real file list. |

## "A detailed MD file of the complete repo, without missing anything"

**Verified, with named exceptions.** Measured on `tailwindlabs/tailwindcss`:
553 blobs in the tree, 551 rendered to markdown, 2 binaries reported as
skipped, **0 unexplained missing** — 2 API requests, 0.9 seconds, 5.81 MB of
markdown.

"Without missing anything" is enforced structurally, not hoped for: every file
the tree lists is either in the output or in a `Truncation` record naming it.
The four ways a file can be absent are all reported by path:

- `binary` — contains a NUL byte in the first 8KB
- `too-large` — above the per-file byte cap (default 2MB)
- `missing` — listed in the tree but absent from the tarball
- `tree-truncated` — GitHub itself truncated the listing

Silent omission is a P0 bug, not a footnote.

### Hard caps that make "complete" impossible, verified from GitHub's docs

- Recursive trees truncates at **100,000 entries or 7MB** of response.
- `compare` returns at most **300 changed files** and does not paginate past
  page 1. A 400-file branch cannot be fully digested this way.
- `pulls/:n/files` caps at **3,000 files**; at 100 per page that is 30
  requests, half the anonymous hourly budget.

## Embeddings

**Not required, and not being added.** Nothing in the feature set needs them:
selection is by path, glob and size, and token estimation is a byte-density
heuristic. Embeddings would only earn their place for *semantic* selection —
"give me the files related to authentication" — which is not a specced feature.

If we add that later, the MV3-compatible free option is
`transformers.js` running `all-MiniLM-L6-v2` (ONNX, ~23MB quantised) on the
WASM backend, which needs `wasm-unsafe-eval` in the extension CSP. The cost is
a ~23MB model download and a full-repo embedding pass on first use. That is a
large price for a feature nobody has asked for yet — propose it, measure it,
then decide.
