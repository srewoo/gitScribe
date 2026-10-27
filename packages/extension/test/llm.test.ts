import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityFor, estimateCostUsd, PROVIDERS, ollamaContext } from '../src/llm.js';

test('capacity: a vendor-documented window beats a user-entered one', () => {
  const c = capacityFor({ provider: 'anthropic', model: 'claude-opus-5', contextWindow: 5 });
  assert.equal(c.source, 'vendor');
  assert.equal(c.contextTokens, 200_000);
});

test('capacity: an unverified model uses the approximate figure; the user can override it', () => {
  const approx = capacityFor({ provider: 'openai', model: 'gpt-5.1' });
  assert.deepEqual([approx.source, approx.contextTokens], ['secondary', 400_000]);
  const c = capacityFor({ provider: 'openai', model: 'gpt-5.1', contextWindow: 128_000 });
  assert.deepEqual([c.source, c.contextTokens], ['user', 128_000]);
  assert.equal(capacityFor({ provider: 'openai', model: 'my-custom-model' }).source, 'unknown');
});

test('capacity: each Ollama model gets its own measured window', () => {
  const windows = { 'llama3:8b': 8192, 'qwen3:32b': 32_768 };
  assert.equal(capacityFor({ provider: 'ollama', model: 'qwen3:32b' }, windows).contextTokens, 32_768);
  assert.equal(capacityFor({ provider: 'ollama', model: 'llama3:8b' }, windows).contextTokens, 8192);
  assert.equal(capacityFor({ provider: 'ollama', model: 'missing' }, windows).source, 'unknown');
});

test('cost and suggestions come from the same registry as windows', () => {
  assert.equal(estimateCostUsd({ provider: 'anthropic', model: 'claude-haiku-4-5' }, 1e6, 1e6), 1 + 5);
  assert.equal(estimateCostUsd({ provider: 'openai', model: 'gpt-5.1' }, 1e6, 1e6), null, 'no unverified price');
  assert.equal(estimateCostUsd({ provider: 'openai', model: 'claude-opus-5' }, 1e6, 1e6), null, 'provider must match');
  assert.ok(PROVIDERS.find((p) => p.id === 'anthropic')!.models.includes('claude-opus-5[1m]'));
});

test('ollama: context is sized to the request, and local runs cost nothing', () => {
  const user = 'x'.repeat(40_000);   // ~10k+ tokens
  const ctx = ollamaContext('system prompt', user, 2000);
  assert.ok(ctx >= 12_000 && ctx % 1024 === 0, String(ctx));
  assert.ok(ollamaContext('s', 'short', 500) <= 2048, 'a short call stays small');
  assert.equal(estimateCostUsd({ provider: 'ollama', model: 'qwen2.5-coder:latest' }, 1e6, 1e6), 0);
});
