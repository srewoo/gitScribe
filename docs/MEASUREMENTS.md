# Measured numbers

Everything here was measured, not estimated. Anything still unmeasured says so.
Re-run with the scripts described at the bottom when the numbers need refreshing.

Measured 2026-09-16, Node 20.17, unauthenticated GitHub, home connection.

## Throughput and memory

| Repository | Blobs | Content | Tree | Digest | Heap delta | Notes |
|---|---|---|---|---|---|---|
| `sindresorhus/slugify` | 13 | 35 KB | — | 1,179 ms | — | 2 requests total |
| `tailwindlabs/tailwindcss` | 553 | 5.5 MB | 777 ms | 923 ms | 10.5 MB | 543 files digested, 2 binaries skipped |
| `gitlab-org/gitlab-runner` (GitLab) | — | 3.7 MB archive | — | — | — | archive path; see the GitLab section |

**Memory holds the design claim.** Digesting a 5.1 MB selection cost 10.5 MB of
heap — roughly 2× the selected bytes, not proportional to the repository. The
streaming tar reader is doing what it was written to do.

**Two requests covers a whole repository** (tree + tarball), which is what keeps
GitHub's 60/hour anonymous tier usable.

## GitHub's tree cap truncates far earlier than the entry limit suggests

`rust-lang/rust` returned `truncated: true` at **60,079 blobs** — well below the
documented 100,000-entry cap. The 7 MB *response size* limit is what actually
bites, and it does so at roughly 60k files with typical path lengths.

So the honest guidance is: expect truncation somewhere above ~50k files, not at
100k. The 100,000 figure in GitHub's documentation is the entry cap, and most
repositories will hit the byte cap first.

Total content for that repository was 213.1 MB across the listed blobs, which is
also a useful upper bound for what "large monorepo" means in practice.

## Token estimate accuracy

Pre-content estimate (from tree sizes alone) vs post-content estimate on
`sindresorhus/slugify`: **10,861 vs 10,782 tokens — 0.7 % apart.** That is the
figure that matters for the live-updating total, since it is computed before any
content downloads.

**Still unmeasured: estimate vs a real tokenizer.** The "biased to over-count by
~5–8 %" claim in the code comments has *not* been validated against
`count_tokens`, because doing so needs an Anthropic API key that this project
does not ship. The extension can now do it per digest (settings → model API
keys → Count exactly), which reports the delta directly. Until someone runs that
on a corpus, treat the 5–8 % as a design intent rather than a measurement.

## GitLab

- **Tree API returns no file size.** Verified: entries carry
  `{id, mode, name, path, type}` only. Per-file cost before download is
  impossible through that endpoint, which is why the GitLab tree is built by
  streaming the archive and reading tar headers instead.
- **Archive downloads are throttled hard for anonymous users, and the status is
  `406 Not Acceptable`, not 429.** Observed after a handful of *fully consumed*
  archive downloads; cheap requests that cancel the body kept returning 200,
  so the shaping is on transferred bytes rather than request count. The block
  outlasted 60 seconds. The regular project and tree APIs stayed at 200
  throughout, so the block is specific to the archive endpoint.
- **API rate limit** reported by headers: `ratelimit-limit: 500` per minute,
  `throttle_unauthenticated_api`. Far more generous than GitHub's 60/hour — but
  irrelevant to the archive endpoint, which is shaped separately.

- **A token does NOT lift the archive throttle.** Observed with a valid token
  showing `1995/2000 req` remaining on the API: the archive still answered 406.
  The two budgets are separate, and an earlier version of this file wrongly
  implied a token would help.

Consequence: the archive cannot be the only content path on GitLab. GitScribe
falls back to the tree API (no sizes, disclosed in the UI) and to per-file `raw`
reads.

**Fallback throughput, measured on `gitlab-org/gitlab-runner`:**

| Approach | Files | Wall time | Requests used |
|---|---:|---:|---|
| Sequential (first implementation) | 277 | 135.8 s | 277 of 500/min |
| Concurrency 6 (shipped) | 277 | **22.2 s** | 277 of 500/min |

Concurrency is deliberately capped at 6: the aim is to stop wasting a generous
budget on sequential waits, not to race the host back into throttling.

## The MV3 service worker question — settled

**Risk 1 from the roadmap is retired.** Run 2026-09-16 against the built
extension loaded into Chromium 153, driving the *shipped* `diagnose` handler
through the real `chrome.runtime.sendMessage` channel:

```
PASS  tarball fetch follows redirect to codeload
      200 https://codeload.github.com/sindresorhus/slugify/legacy.tar.gz/refs/heads/main
PASS  DecompressionStream gzip in the worker
      51200 bytes decompressed
```

So the `api.github.com` → `codeload.github.com` redirect **is** followed from
the background service worker and **is** exempt from CORS with
`host_permissions` covering both hosts, and the platform's gzip decoder works
there. The content strategy stands; no fallback to per-blob fetches is needed.

A full digest through the same channel matched the Node numbers exactly:
13 files, ~10,782 tokens, `tarball` strategy, **1 request**.

GitLab in the same run returned 1,440 files with `sizesUnknown: true` — i.e. the
archive was throttled and the **tree-API fallback fired correctly inside the
extension**, which is the first end-to-end confirmation of that path.

Token validation rejected a fabricated token with
`Rejected (401). The token is wrong, revoked, or expired.`

### Reproducing it without clicking

`--load-extension` is ignored by current Chrome stable (152), so use
Playwright's Chromium (153) instead:

```js
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
// MV3 workers are lazy; open an extension page, then:
// page.evaluate((m) => new Promise(r => chrome.runtime.sendMessage(m, r)), {kind:'diagnose'})
```

The unpacked extension id is derived from the sha256 of its absolute path:
first 16 bytes, each nibble mapped onto `a`..`p`.

## Correction: extension test count was inflated

An earlier revision of this file, and several session summaries, reported 12
passing extension tests. Six of those were **stale compiled output** from a
module that had been moved to core; the compile step wrote into an existing
directory and the runner executed whatever `.js` it found. The real figure was
6. Test scripts now delete the generated test output before compiling, so the
inventory always derives from current source.

## Not yet measured

- Peak memory on a genuinely large selection (>100 MB). The 5.1 MB figure above
  is the largest measured.
- Decode throughput for a ~50 MB archive.

## Reproducing

The measurement scripts are throwaway; rebuild them from this shape:

```js
import { nodeEnv, GitHubClient, buildDigest, applySelection, DEFAULT_EXCLUDES }
  from '@gitscribe/core';
// getRepo -> getTree -> applySelection -> buildDigest, timing each step and
// sampling process.memoryUsage() around the digest. Run with --expose-gc.
```
