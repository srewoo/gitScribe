import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from '../src/busy.js';

test('busy: elapsed time reads as minutes and seconds', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(7_900), '0:07');
  assert.equal(formatElapsed(102_000), '1:42');
  assert.equal(formatElapsed(-5), '0:00');
});
