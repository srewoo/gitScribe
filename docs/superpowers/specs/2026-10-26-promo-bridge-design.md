# Promo bridge (repo URL → /brag) — design

Status: approved in conversation, 2026-10-26. Sub-project 3 of 3.

## Goal

Make a brag-style promo video for any GitHub/GitLab repository from its URL,
without cloning, by handing the installed `/brag` skill a faithful local copy
plus GitScribe's checked architecture facts. GitScribe does no rendering and no
creative direction: brag and HyperFrames own both.

## 1. `gitscribe_snapshot` (MCP tool)

Input: `repo`, `ref?`, `include?`, `exclude?`, `dir?`.

Writes to `dir` or `<os tmp>/gitscribe/<owner>-<repo>-<sha7>/`:

- **Text files** from the digest (default selection), secrets redacted.
- **Never written:** env files, key material (`*.pem`, `*.key`, `*.p12`,
  `id_rsa*`, `*credentials*.json`, `*service-account*.json`), anything under
  `secrets/` or `credentials/`. Listed as skipped.
- **Images** (`png jpg jpeg gif svg webp ico avif`) ≤ 1 MB each, at most 40,
  preferring `public/`, `assets/`, `static/`, and names with logo/icon/favicon/
  screenshot/hero/og. Read from the same archive; on GitLab 406, fetched raw.
- **`.gitscribe/`**: `architecture.mmd` (Mermaid), `tour.json` (code-only
  onboarding tour), `facts.md` (counts, entry points, main modules, packages,
  skipped/redacted summary). Every fact is derived from the code.
- Every write path goes through `safeRelative`: no absolute paths, no `..`
  escaping, no NUL or backslash; anything else is skipped and reported.

Returns the directory, counts, and the skipped list.

## 2. `promo` (MCP prompt → `/mcp__gitscribe__promo <repo> [tone]`)

Instructs Claude Code to: call `gitscribe_snapshot`; run `/brag` on that
directory with the given tone, adding the direction that an optional "how it's
built" beat may use only `.gitscribe/tour.json` and `facts.md`; report the
output path.

## Code

- `core/src/snapshot-files.ts` (pure): `safeRelative`, `isSensitivePath`,
  `isImage`, `pickImages`, `snapshotExtras`.
- `mcp/src/snapshot.ts`: fetch + write (node:fs). `server.ts`: tool + prompt.

## Testing

- `snapshot-files.test.ts`: traversal paths rejected; sensitive paths
  detected; image picking honours size, count and priority; extras contain
  only real paths and the right counts.
- MCP contract: 11 tools; `promo` prompt registered.
- Live: snapshot `srewoo/paintBrush`, verify files/extras, then run `/brag`
  on it and render a promo.
