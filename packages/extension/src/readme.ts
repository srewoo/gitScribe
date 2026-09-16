import {
  planBudget,
  batchWithinAllowance,
  estimateFromText,
  partitionDigest,
  render,
  checkGrounding,
  groundingNotice,
  ANALYSIS_PROMPT,
  SYNTHESIS_PROMPT,
  type Digest,
  type GroundingReport,
} from '@gitscribe/core';
import { complete, estimateCostUsd, capacityFor, type ModelChoice } from './llm.js';

/**
 * Turn a repository digest into a README written for a model to navigate by.
 *
 * Map-reduce, because a real repository does not fit one context window:
 *   map    — each chunk of files is summarised into a compact module note
 *   reduce — those notes (not the code) become the final document
 *
 * The map model and the reduce model are chosen independently, because mapping
 * is bulk work over a lot of tokens and synthesis is where quality shows.
 */

export interface ReadmePlan {
  readonly parts: number;
  readonly mapInputTokens: number;
  readonly reduceInputTokens: number;
  readonly calls: number;
  /** Null when the provider publishes no rate we have verified. */
  readonly estimatedCostUsd: number | null;
}

/** Output tokens we expect per call — used only for the cost estimate. */
const MAP_OUTPUT = 900;
const REDUCE_OUTPUT = 6000;
/** What we actually ask the provider for, which budgeting must subtract. */
export const MAP_MAX_OUTPUT = 2000;
export const REDUCE_MAX_OUTPUT = 16_000;

/**
 * Derive the per-request allowance from the chosen models instead of a fixed
 * constant. Returns null allowances when a model's window is unknown, so the
 * caller must ask rather than assume.
 */
export function resolveBudgets(
  mapChoice: ModelChoice,
  reduceChoice: ModelChoice,
  ollamaWindow?: number,
): { map: ReturnType<typeof planBudget>; reduce: ReturnType<typeof planBudget> } {
  return {
    map: planBudget({
      capacity: capacityFor(mapChoice, ollamaWindow),
      requestedOutput: MAP_MAX_OUTPUT,
      systemTokens: estimateFromText('p.md', ANALYSIS_PROMPT),
      overheadTokens: 800,
    }),
    reduce: planBudget({
      capacity: capacityFor(reduceChoice, ollamaWindow),
      requestedOutput: REDUCE_MAX_OUTPUT,
      systemTokens: estimateFromText('p.md', SYNTHESIS_PROMPT),
      overheadTokens: 800,
    }),
  };
}

export function planReadme(
  d: Digest,
  mapChoice: ModelChoice,
  reduceChoice: ModelChoice,
  chunkBudget: number,
): ReadmePlan {
  const parts = partitionDigest(d, { budget: chunkBudget }).parts;
  const mapInput = d.totalTokens;
  const reduceInput = parts.length * MAP_OUTPUT;

  const mapCost = estimateCostUsd(mapChoice, mapInput, parts.length * MAP_OUTPUT);
  const reduceCost = estimateCostUsd(reduceChoice, reduceInput, REDUCE_OUTPUT);

  return {
    parts: parts.length,
    mapInputTokens: mapInput,
    reduceInputTokens: reduceInput,
    calls: parts.length + 1,
    estimatedCostUsd: mapCost === null || reduceCost === null ? null : mapCost + reduceCost,
  };
}

/** Notes already completed in a previous attempt, keyed by part index. */
export type ResumeNotes = Readonly<Record<string, string>>;

export interface GenerateArgs {
  readonly digest: Digest;
  readonly mapChoice: ModelChoice;
  readonly reduceChoice: ModelChoice;
  readonly mapKey: string;
  readonly reduceKey: string;
  readonly chunkBudget: number;
  /** Allowance for one synthesis request; drives staged reduction. */
  readonly reduceAllowance?: number;
  readonly onProgress?: (done: number, total: number, label: string) => void;
  /** Reuse these instead of re-calling the model for those parts (IMP-07). */
  readonly resumeNotes?: ResumeNotes;
  /** Called after each part so the caller can checkpoint durably. */
  readonly onNote?: (part: number, note: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface GenerateResult {
  readonly markdown: string;
  readonly notes: readonly string[];
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Chunks the model failed on. The run continues; these are reported. */
  readonly failures: readonly { part: number; error: string }[];
  /** Which paths the document claims, and which of those are real. */
  readonly grounding: GroundingReport;
}

export async function generateReadme(a: GenerateArgs): Promise<GenerateResult> {
  const parts = partitionDigest(a.digest, { budget: a.chunkBudget }).parts;
  const notes: string[] = [];
  const failures: { part: number; error: string }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;

  for (const part of parts) {
    if (a.signal?.aborted) throw new Error('Cancelled before part ' + part.index);

    // Reuse a completed part rather than paying for it again. This is the
    // whole point of checkpointing: a restart must not re-bill finished work.
    const already = a.resumeNotes?.[String(part.index)];
    if (already !== undefined && already.trim() !== '') {
      notes.push(already);
      a.onProgress?.(part.index, parts.length + 1, `Reusing part ${part.index} of ${parts.length}`);
      continue;
    }

    a.onProgress?.(part.index - 1, parts.length + 1, `Reading part ${part.index} of ${parts.length}`);
    const slice: Digest = { ...a.digest, files: part.files, totalTokens: part.tokens };
    try {
      const res = await complete({
        choice: a.mapChoice,
        apiKey: a.mapKey,
        system: ANALYSIS_PROMPT,
        user: render(slice, 'md'),
        maxTokens: MAP_MAX_OUTPUT,
        ...(a.signal ? { signal: a.signal } : {}),
      });
      calls++;
      inputTokens += res.inputTokens ?? 0;
      outputTokens += res.outputTokens ?? 0;
      if (res.text.trim()) {
        const note = res.text.trim();
        notes.push(note);
        await a.onNote?.(part.index, note);
      }
    } catch (e) {
      // One bad chunk must not lose the whole run; record and carry on.
      failures.push({ part: part.index, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (notes.length === 0) {
    throw new Error(
      `Every chunk failed, so there is nothing to synthesise. First error: ${
        failures[0]?.error ?? 'unknown'
      }`,
    );
  }

  // Reduce in stages when the notes exceed what the synthesis model can hold.
  // Sending every note in one request was the remaining way to overflow.
  if (a.signal?.aborted) throw new Error('Cancelled before synthesis');

  let working = notes;
  if (a.reduceAllowance !== undefined && a.reduceAllowance > 0) {
    let round = 0;
    while (round < 3) {
      const batches = batchWithinAllowance(working, a.reduceAllowance, (t) =>
        estimateFromText('n.md', t),
      );
      if (batches.length <= 1) break;
      round++;
      a.onProgress?.(parts.length, parts.length + 2, `Condensing notes (pass ${round})`);
      const condensed: string[] = [];
      for (const batch of batches) {
        const r = await complete({
          choice: a.reduceChoice,
          apiKey: a.reduceKey,
          system: SYNTHESIS_PROMPT,
          user: `Condense these module notes, preserving every path and fact:\n\n${batch.join('\n\n---\n\n')}`,
          maxTokens: MAP_MAX_OUTPUT,
          ...(a.signal ? { signal: a.signal } : {}),
        });
        calls++;
        inputTokens += r.inputTokens ?? 0;
        outputTokens += r.outputTokens ?? 0;
        if (r.text.trim()) condensed.push(r.text.trim());
      }
      if (condensed.length === 0 || condensed.length >= working.length) break;
      working = condensed;
    }
  }

  a.onProgress?.(parts.length, parts.length + 1, 'Writing the README');
  const res = await complete({
    choice: a.reduceChoice,
    apiKey: a.reduceKey,
    system: SYNTHESIS_PROMPT,
    user:
      `Repository: ${a.digest.owner ? `${a.digest.owner}/` : ''}${a.digest.repo} at ${a.digest.ref}\n` +
      `${a.digest.files.length} files were read across ${parts.length} pass(es).\n\n` +
      `Per-module notes follow.\n\n${working.join('\n\n---\n\n')}`,
    maxTokens: REDUCE_MAX_OUTPUT,
    ...(a.signal ? { signal: a.signal } : {}),
  });
  calls++;
  inputTokens += res.inputTokens ?? 0;
  outputTokens += res.outputTokens ?? 0;
  a.onProgress?.(parts.length + 1, parts.length + 1, 'Done');

  let markdown = res.text.trim();

  // Anything the run could not read is stated in the document itself, not just
  // in the UI: a README that silently omits a module is worse than one that
  // says which modules are missing.
  const omissions: string[] = [];
  for (const t of a.digest.truncations) {
    // The paths are the useful part; copying only the summary sentence hides
    // exactly which files are missing.
    const paths = t.paths ?? [];
    omissions.push(
      paths.length > 0
        ? `${t.detail}\n${paths.map((p) => `  - \`${p}\``).join('\n')}`
        : t.detail,
    );
  }
  for (const f of failures) omissions.push(`Part ${f.part} could not be read: ${f.error}`);
  if (omissions.length > 0) {
    markdown +=
      `\n\n## Coverage gaps\n\nThis README was generated from an incomplete read of the repository:\n\n` +
      omissions.map((o) => `- ${o}`).join('\n');
  }
  // Prompts forbid inventing files; prompts are not enforcement. Check.
  const grounding = checkGrounding(markdown, a.digest.files.map((f) => f.path));
  markdown += groundingNotice(grounding, a.digest.files.length);

  markdown +=
    `\n\n---\n\nGenerated by GitScribe from ${a.digest.files.length} files at ` +
    `${a.digest.ref.slice(0, 8)} using ${a.mapChoice.model} (analysis) and ` +
    `${a.reduceChoice.model} (synthesis). Descriptions are model-generated and may contain errors.\n`;

  return { markdown, notes, calls, inputTokens, outputTokens, failures, grounding };
}
