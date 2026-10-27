import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_REGISTRY, lookupModel, staleEntries } from '../src/registry.js';
import { MODELS } from '../src/models.js';

test('registry: MODELS is derived from the registry, so the two can never disagree', () => {
  for (const m of MODELS) {
    const r = lookupModel(m.id);
    assert.ok(r, `${m.id} missing from the registry`);
    assert.equal(m.contextWindow, r.contextTokens, `${m.id} window`);
    assert.equal(m.windowSource, r.provenance === 'vendor-docs' ? 'vendor' : r.provenance === 'runtime' ? 'runtime' : 'secondary');
  }
  const withWindow = MODEL_REGISTRY.filter((r) => r.contextTokens !== null).map((r) => r.id);
  assert.deepEqual(MODELS.map((m) => m.id), withWindow, 'every model with a known window is offered');
});

test('registry: one id per model (no dated alias drifting from the short id)', () => {
  const ids = MODEL_REGISTRY.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(lookupModel('claude-haiku-4-5'));
  assert.equal(lookupModel('claude-haiku-4-5-20251001'), null);
});

test('registry: approximate windows are marked secondary, never as vendor-verified', () => {
  for (const id of ['gpt-5.1', 'gemini-3-pro', 'grok-4']) {
    const r = lookupModel(id)!;
    assert.equal(r.provenance, 'secondary', id);
    assert.ok(r.contextTokens! > 0, id);
    assert.equal(r.pricePerMTokIn, undefined, `${id}: no unverified price`);
  }
});

test('registry: passes its own freshness and consistency check', () => {
  assert.deepEqual(staleEntries(90, Date.parse('2026-10-01')), []);
});
