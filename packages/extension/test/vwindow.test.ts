import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRange } from '../src/vwindow.js';

const H = 24, OVER = 8;

test('window: covers every row that is on screen, at the top', () => {
  const { first, last } = visibleRange(0, 860, 26_418, H, OVER);
  assert.equal(first, 0);
  // 860/24 = 35.8 -> 36 rows visible; must cover at least that many
  assert.ok(last >= 36, `last=${last} must cover the visible rows`);
});

test('window: covers the row straddling the top edge', () => {
  // scrolled half a row down: row 0 is still partly visible
  const { first } = visibleRange(12, 860, 1000, H, OVER);
  assert.equal(first, 0, 'overscan must keep the straddling row painted');
});

test('window: never runs past the end of the list', () => {
  const { first, last } = visibleRange(999_999, 860, 100, H, OVER);
  assert.ok(last <= 100);
  assert.ok(first <= last);
});

test('window: bounded regardless of how many files there are', () => {
  const small = visibleRange(0, 860, 500, H, OVER);
  const huge = visibleRange(0, 860, 26_418, H, OVER);
  assert.equal(huge.last - huge.first, small.last - small.first);
  assert.ok(huge.last - huge.first < 70, 'painted rows must stay a few dozen');
});

test('window: scrolling moves the window without gaps', () => {
  // consecutive scroll positions must produce overlapping or touching ranges
  let prev = visibleRange(0, 860, 5000, H, OVER);
  for (let top = H; top < 4000; top += H) {
    const cur = visibleRange(top, 860, 5000, H, OVER);
    assert.ok(cur.first <= prev.last, `gap at scrollTop=${top}`);
    prev = cur;
  }
});

test('window: degenerate inputs do not throw or invert', () => {
  assert.deepEqual(visibleRange(0, 860, 0, H, OVER), { first: 0, last: 0 });
  assert.deepEqual(visibleRange(0, 0, 10, H, OVER).first, 0);
  assert.deepEqual(visibleRange(-50, 860, 10, H, OVER).first, 0);
});
