import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGrounding, groundingNotice } from '../src/grounding.js';

const REAL = ['index.js', 'index.d.ts', 'test.js', 'src/util/slug.ts', 'package.json'];

test('grounding: real paths are verified, invented ones are not', () => {
  const md = 'See `index.js` and `src/util/slug.ts`, plus `acronyms.test.js`.';
  const r = checkGrounding(md, REAL);
  assert.ok(r.verified.includes('index.js'));
  assert.ok(r.verified.includes('src/util/slug.ts'));
  assert.deepEqual(r.unverified, ['acronyms.test.js']);
});

test('grounding: a bare filename matching a real path counts as verified', () => {
  const r = checkGrounding('The entry point is `slug.ts`.', REAL);
  assert.deepEqual(r.unverified, []);
  assert.ok(r.verified.includes('slug.ts'));
});

test('grounding: a real directory is verified; a fake one is NOT accused', () => {
  // Deliberate trade-off. An extension-less path like `src/nope` is
  // indistinguishable from a repo slug or package name, and false accusations
  // make the whole check untrustworthy. Real directories still verify; fake
  // ones are simply not claimed either way. Fabricated FILES are still caught.
  const r = checkGrounding('### src/util\n\n### src/nope', REAL);
  assert.ok(r.verified.includes('src/util'));
  assert.ok(!r.unverified.includes('src/nope'), 'must not accuse an extension-less path');
});

test('grounding: prose and non-paths are ignored', () => {
  const r = checkGrounding('Uses `npm` and `AVA` for `testing`.', REAL);
  assert.deepEqual(r.verified, []);
  assert.deepEqual(r.unverified, []);
});

test('grounding: the real hallucination from testing is caught', () => {
  // Observed output from a small local model on sindresorhus/slugify.
  const md = [
    '- `index.test.js`: Main test file',
    '- `acronyms.test.js`: Tests for handling acronyms',
    '- `contractions.test.js`: Tests for contractions',
    '- `options.test.js`: Tests for options',
  ].join('\n');
  const r = checkGrounding(md, REAL);
  assert.equal(r.unverified.length, 4, 'all four invented files must be flagged');
  assert.equal(r.verified.length, 0);
});

test('groundingNotice is empty when everything checks out', () => {
  assert.equal(groundingNotice({ verified: ['a.ts'], unverified: [] }), '');
  assert.match(groundingNotice({ verified: [], unverified: ['ghost.ts'] }), /ghost\.ts/);
});

/* --- false positives observed in a real run; each one cost trust --- */

test('grounding: backticks inside a heading are stripped before matching', () => {
  // A real run flagged `.github/security.md` as fabricated because the heading
  // captured the backticks along with the path.
  const real = ['.github/security.md', '.github/workflows/main.yml'];
  const r = checkGrounding('### `.github/security.md`\n#### `.github/workflows/main.yml`', real);
  assert.deepEqual(r.unverified, []);
  assert.equal(r.verified.length, 2);
});

test('grounding: npm package names are not treated as paths', () => {
  const r = checkGrounding('Install `@sindresorhus/slugify` and `@scope/thing`.', REAL);
  assert.deepEqual(r.unverified, []);
});

test('grounding: a repository slug is not accused of being a fake file', () => {
  const r = checkGrounding('Source: `sindresorhus/slugify` on GitHub.', REAL);
  assert.deepEqual(r.unverified, []);
});

test('grounding: fabricated FILES are still caught after the loosening', () => {
  const r = checkGrounding('See `acronyms.test.js` and `src/nope/thing.ts`.', REAL);
  assert.deepEqual([...r.unverified].sort(), ['acronyms.test.js', 'src/nope/thing.ts']);
});
