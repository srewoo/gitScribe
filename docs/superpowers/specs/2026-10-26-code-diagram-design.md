# Code diagram — design

Status: approved in conversation, 2026-10-26. Sub-project 1 of 3
(diagram → walkthrough video → brag-style promo). The video sub-projects get
their own specs and build on the graph defined here.

## Goal

Draw an architecture diagram of a repository whose **edges are facts**: every
arrow is an import that exists in the code. A model may name and group things;
it may never add a file or an arrow. This is the difference from tools such as
GitDiagram, where a model infers the arrows from the file tree.

## Non-goals (v1)

- Languages other than JS/TS/HTML. Python and Go plug in later behind the same
  interface.
- TypeScript path aliases (`@/x`) and `tsconfig` `paths`. Reported as
  unresolved, never guessed.
- A full TypeScript parser. Pattern matching only; the compiler is ~3MB.
- Bundling Mermaid. Mermaid is an export format, not the renderer.

## 1. Graph building — `packages/core/src/graph.ts`

Pure, no network, no model. Input: a `Digest` (already holds selected files'
text). Output:

```ts
interface CodeGraph {
  nodes: GraphNode[];          // source files
  edges: GraphEdge[];          // from → to, both real paths in the digest
  unresolved: Unresolved[];    // { from, specifier, reason: 'alias' | 'missing' }
  external: string[];          // bare package specifiers, deduplicated
  skipped: string[];           // non-code files left out of the diagram
  outline: FileOutline[];      // { path, imports, exports, leadComment }
}
```

Recognised edges:

- `import … from 'x'`, `import 'x'`, `export … from 'x'`, `import('x')`,
  `require('x')`.
- `<script src="x">` in `.html` files.

Resolution: relative specifiers resolve against the digest's file set, trying
the specifier as-is, then `.ts .tsx .js .jsx .mjs .cjs`, then `/index.*`. A
`.js` specifier also tries the same stem with `.ts`/`.tsx` (TS ESM convention).
An edge is created only when the target exists. Bare specifiers go to
`external`; anything else unresolvable goes to `unresolved` with a reason.

Known ceiling: an `import` inside a string or comment can rarely produce a
false edge. Accepted for v1; marked with a `ponytail:` comment naming the
upgrade (a real tokenizer).

## 2. Grouping and labelling

### Grouping — deterministic, in `graph.ts`

- ≤ 40 source files: one box per file; each folder becomes a labelled cluster.
- \> 40: one box per module, where a module is the deepest folder depth that
  still yields ≤ 40 boxes (most detail within the cap). If even the top level
  exceeds 40, the largest 39 folders get boxes and the rest share one "other". Edges between modules aggregate, with a weight (import
  count) that sets stroke width. A module expands in place to its files.
- Non-code files are listed in `skipped`, not drawn.

### Labelling — optional, `packages/core/src/labels.ts`

- Uses the user's **synthesis model** (no new setting; Ollama works).
- Sends only `outline` — never file bodies. Goes through the existing
  prepare/review step: destination provider and estimated cost shown before
  anything is sent.
- Model returns JSON: `{ nodes: {path: label}, clusters: {folder: name},
  edges: [{from, to, verb}], entry?: label }`.
- `validateLabels(graph, reply)`:
  - drops any node path or edge not in the graph, and counts the drops
    ("N invented connections ignored");
  - cluster names may rename a real folder, never move a file between folders;
  - invalid JSON → unlabelled diagram plus a warning; nothing else fails.
- Labels are cached per pinned commit + selection, so reopening costs nothing.

## 3. Surfaces

### Extension — Diagram tab

New files only; `sidepanel.ts` (~1,900 lines) gets just the wiring.

- `src/diagram.ts` — layout via `@dagrejs/dagre` (~30KB) and SVG rendering we
  own (needed so sub-project 2 can animate it).
- `src/diagram-view.ts` — the tab: build, label, interaction, export.
- Lazy-loaded when the tab is first opened, so panel start-up is unchanged.

Behaviour:

- **Build diagram**: instant, free, from the current selection.
- **Label with AI**: prepare → review → send, same gate as README generation.
- Zoom (wheel), pan (drag), hover highlights in/out edges, click opens the file
  on GitHub/GitLab at the pinned commit, click a module to expand.
- Keyboard: arrows move between nodes, Enter opens. Nodes have accessible names.
- Footer lists unresolved imports, skipped files, and dropped model claims.
- Export: Mermaid text (copy), SVG, PNG (rasterised from the SVG in-page).
- A selection change marks the diagram stale with a Rebuild prompt.
- Theme follows the panel's light/dark setting.

### Core — Mermaid export

`toMermaid(graph, labels?)` in `render.ts`. Node ids sanitised; labels escaped.

### MCP — `gitscribe_diagram`

- Input: `repo`, `ref?`, `include?`, `exclude?`, `labels?`.
- Returns Mermaid, the graph JSON, the exclusions report, plus the outline and
  a labelling prompt. The server calls no model (as with the README tools); the
  caller labels and passes `labels` back, which runs through the same
  `validateLabels`.
- Contract test grows from 9 to 10 tools.

## Testing

- `graph.test.ts`: each import form; extension and index resolution; `.js`→`.ts`
  mapping; `<script src>`; alias and missing cases land in `unresolved`; bare
  specifiers land in `external`.
- Grouping: a synthetic 26,000-file tree yields ≤ 40 boxes; a 30-file tree
  yields per-file boxes.
- `labels.test.ts`: invented nodes and edges are dropped and counted; a cluster
  rename cannot move a file; malformed JSON degrades to unlabelled.
- `toMermaid`: output for a small graph is stable and escapes awkward names.
- MCP contract test: `gitscribe_diagram` registered with `repo` required.
- Live check (not CI): build and label `srewoo/paintBrush` in the panel.

## Open for later sub-projects

The walkthrough video consumes `CodeGraph` + labels + the SVG renderer's
per-node elements to animate a guided tour. Nothing in this spec should make
nodes or edges hard to address individually.
