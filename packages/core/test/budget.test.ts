import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBudget, batchWithinAllowance, type ModelCapacity } from '../src/budget.js';

const vendor = (ctx: number | null, out: number | null = 8192): ModelCapacity =>
  ({ contextTokens: ctx, maxOutputTokens: out, source: 'vendor' });

test('budget: a small window yields a small allowance, not the old 120k default', () => {
  const b = planBudget({ capacity: vendor(8192), requestedOutput: 2000, systemTokens: 400 });
  assert.ok(b.inputAllowance !== null);
  assert.ok(b.inputAllowance < 8192, 'must be less than the window');
  assert.ok(b.inputAllowance > 0);
  assert.equal(b.needsUserInput, false);
});

test('budget: unknown capacity is never replaced by a default', () => {
  const b = planBudget({ capacity: vendor(null, null), requestedOutput: 2000, systemTokens: 400 });
  assert.equal(b.inputAllowance, null);
  assert.equal(b.needsUserInput, true);
  assert.match(b.reason, /unknown/i);
});

test('budget: a window too small for the requested output refuses rather than clamps', () => {
  const b = planBudget({ capacity: vendor(4096), requestedOutput: 4000, systemTokens: 400 });
  assert.equal(b.inputAllowance, null);
  assert.equal(b.needsUserInput, true);
});

test('budget: output is capped at the model maximum', () => {
  const small = planBudget({ capacity: vendor(200_000, 4096), requestedOutput: 64_000, systemTokens: 0 });
  const large = planBudget({ capacity: vendor(200_000, 64_000), requestedOutput: 64_000, systemTokens: 0 });
  assert.ok(small.inputAllowance! > large.inputAllowance!, 'clamped output leaves more room for input');
});

test('budget: allowance shrinks as instructions and overhead grow', () => {
  const bare = planBudget({ capacity: vendor(100_000), requestedOutput: 2000, systemTokens: 0 });
  const heavy = planBudget({
    capacity: vendor(100_000), requestedOutput: 2000, systemTokens: 5000, overheadTokens: 3000,
  });
  assert.equal(bare.inputAllowance! - heavy.inputAllowance!, 8000);
});

/* --- staged reduction --- */

const est = (s: string): number => s.length;

test('batching: notes are grouped within the allowance', () => {
  const notes = Array.from({ length: 10 }, () => 'x'.repeat(30));
  const batches = batchWithinAllowance(notes, 100, est);
  for (const b of batches) assert.ok(b.reduce((n, s) => n + est(s), 0) <= 100);
  assert.equal(batches.flat().length, 10, 'nothing dropped');
});

test('batching: an oversized single note gets its own batch rather than being hidden', () => {
  const batches = batchWithinAllowance(['a'.repeat(500), 'b'.repeat(10)], 100, est);
  assert.equal(batches[0]!.length, 1);
  assert.equal(batches[0]![0]!.length, 500);
  assert.equal(batches.flat().length, 2);
});

test('batching: order is preserved so contiguous modules stay together', () => {
  const notes = ['a', 'b', 'c', 'd'];
  assert.deepEqual(batchWithinAllowance(notes, 2, est).flat(), notes);
});
