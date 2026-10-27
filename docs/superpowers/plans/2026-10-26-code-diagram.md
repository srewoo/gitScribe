# Code Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repository diagram whose arrows are real imports, optionally named and grouped by a model that cannot add files or arrows.

**Architecture:** Core builds a `CodeGraph` from a `Digest` (pure, offline), groups it adaptively, validates model labels against it, and exports Mermaid. The extension lays it out with dagre and renders its own SVG in a lazy-loaded Diagram tab; the MCP server exposes the same graph as `gitscribe_diagram`.

**Tech Stack:** TypeScript (strict), node:test, esbuild, `@dagrejs/dagre@3.1.1`, MV3.

**Spec:** `docs/superpowers/specs/2026-10-26-code-diagram-design.md`

## Global Constraints

- Edges only between files present in the digest; never inferred.
- Model input is the outline only — never file bodies.
- Unresolved imports, skipped files and dropped model claims are always reported.
- Per-file view at ≤ 40 source files; otherwise module view with ≤ 40 boxes.
- `@dagrejs/dagre` pinned to `3.1.1` (3.1.2/3.1.3 are under two weeks old).
- No file over 300 lines in new code; `sidepanel.ts` gets wiring only.
- Do not commit (user preference). Leave changes in the working tree.

Deviation from spec: `toMermaid` lives in a new `core/src/mermaid.ts`, not
`render.ts`, which is already ~270 lines.

---

### Task 1: Graph building and grouping (core)

**Files:** Create `packages/core/src/graph.ts`, `packages/core/test/graph.test.ts`; modify `packages/core/src/index.ts`.

**Produces:**
- `buildGraph(d: Digest): CodeGraph`
- `groupGraph(g: CodeGraph, max = 40): GraphView` — `{ mode: 'file' | 'module', boxes: Box[], links: Link[] }` where `Box = { id, label, cluster, files: string[] }`, `Link = { from, to, weight }`.
- `isCode(path): boolean`

Tests (all must fail first, then pass):
- each import form → edge; `./x.js` → `x.ts`; `./dir` → `dir/index.ts`; `<script src>` in HTML.
- bare specifier → `external`; `@/x` → `unresolved` reason `alias`; `./nope` → `missing`.
- non-code files → `skipped`.
- 30 files → `mode: 'file'`, 30 boxes; 26,000 files across nested dirs → `mode: 'module'`, ≤ 40 boxes, weights sum to cross-module edge count.

### Task 2: Label validation (core)

**Files:** Create `packages/core/src/labels.ts`, `packages/core/test/labels.test.ts`.

**Consumes:** `CodeGraph`, `GraphView`.
**Produces:** `LABEL_PROMPT`, `labelRequest(g, view): string` (outline + box ids as text), `validateLabels(view, raw: string): { labels: DiagramLabels; dropped: string[]; warning?: string }`, `DiagramLabels = { boxes: Record<id,string>; clusters: Record<string,string>; links: Record<'from→to', string>; entry?: string }`.

Tests: invented box id and invented link dropped and counted; cluster rename keeps membership; fenced/garbage JSON → empty labels + warning.

### Task 3: Mermaid export (core)

**Files:** Create `packages/core/src/mermaid.ts`; add to `graph.test.ts` or new `mermaid.test.ts`.

**Produces:** `toMermaid(view: GraphView, labels?: DiagramLabels): string`.

Tests: stable output for a two-box graph; ids sanitised; quotes/brackets in labels escaped.

### Task 4: MCP tool

**Files:** Modify `packages/mcp/src/server.ts`, `scripts/mcp-contract-test.mjs`.

`gitscribe_diagram({ repo, ref?, include?, exclude?, labels? })` → Mermaid + exclusions report + `LABEL_PROMPT` + `labelRequest`. With `labels`, runs `validateLabels` and reports drops. Contract test expects 10 tools.

### Task 5: Layout + SVG renderer (extension)

**Files:** Create `packages/extension/src/diagram.ts`, `packages/extension/test/diagram.test.ts`; add dependency.

**Produces:** `layoutDiagram(view, labels?): Layout` (pure, dagre) and `renderSvg(layout, opts): SVGSVGElement` with `data-box`/`data-link` attributes per element (the video sub-project addresses these).

Test: every box gets a position; no two boxes overlap; links reference laid-out boxes.

### Task 6: Diagram tab (extension)

**Files:** Create `packages/extension/src/diagram-view.ts`; modify `sidepanel.html`, `sidepanel.ts` (tab + lazy import only), `background.ts` (`diagram`, `labelDiagram` messages).

Behaviour per spec §3: build, label (review gate showing provider and outline size), zoom/pan, hover, click-to-open at pinned commit, module expand, keyboard, footer report, export Mermaid/SVG/PNG, stale on selection change. Labels cached in the worker per commit + selection.

### Task 7: Docs and live check

README: Diagram section + MCP table row. Live: build and label `srewoo/paintBrush` and a large repo in headless Chromium; screenshot.
