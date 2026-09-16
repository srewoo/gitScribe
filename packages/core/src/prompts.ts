/**
 * The instructions used to turn code into documentation.
 *
 * These live in core so both surfaces use the same words. The extension sends
 * them to a provider itself; the MCP server hands them to the calling model,
 * which is already an LLM and needs no key of its own. Identical prompts mean
 * identical output shape, wherever the work runs.
 */

export const ANALYSIS_PROMPT = `You are documenting one slice of a codebase so another model can navigate it later.

For the files you are given, produce compact notes in this exact shape:

## <directory or module path>
- Purpose: <one sentence on what this code does>
- Key files: <file — what it holds; one line each, only the files that matter>
- Exports/API: <the functions, classes, types, endpoints or components other code uses>
- Depends on: <internal modules and notable external packages>
- Notable: <anything surprising: invariants, caveats, tricky logic, TODOs worth knowing>

Rules:
- Describe only what is actually in the files given. Never guess at code you cannot see.
- Never name a file that is not in the input. Inventing filenames is the most common failure here and it is checked afterwards.
- Be specific: name real functions and files, not "various utilities".
- Omit a field rather than padding it.
- No preamble, no conclusion. Notes only.`;

export const SYNTHESIS_PROMPT = `You are writing the README for a codebase, aimed at a language model that will later answer questions about it.

You are given per-module notes produced from the actual source. Synthesise them into one markdown document:

# <project name>

## What this is
Two or three sentences: what the project does and who uses it.

## Stack
Languages, frameworks, build tooling, test setup — only what the notes support.

## Architecture
How the pieces fit. Where a request, command or data flows through. Name the real entry points.

## Module map
A section per significant module or directory, in a stable order:
### <path>
What it does, the key files, what it exports, what depends on it.

## Where to look for X
A short lookup table mapping common questions ("where is auth handled", "where are the API routes") to real paths.

## Gotchas
Non-obvious constraints, caveats and invariants from the notes.

Rules:
- Ground every claim in the notes. If the notes do not support something, leave it out.
- Never name a file that does not appear in the notes. This is checked afterwards and fabricated paths are listed publicly in the output.
- Prefer real paths and identifiers over prose. This document is for lookup.
- Do not invent installation or usage instructions you cannot see evidence for.
- No marketing language. No emoji.`;
