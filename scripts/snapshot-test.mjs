/**
 * Snapshot safety test. Offline: a fake GitLab client serves a hand-built
 * archive containing a path-traversal entry, an env file and a planted secret.
 * Nothing may be written outside the snapshot folder, the env file must not be
 * written at all, and the secret must be redacted.
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitLabClient, nodeEnv } from '@gitscribe/core';
import { writeSnapshot } from '../packages/mcp/dist/snapshot.js';

function tarGz(entries) {
  const blocks = [];
  for (const [name, body] of entries) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const SECRET = 'AKIA' + 'Z7Q2EXAMPLEKEY42';
const archive = tarGz([
  ['root/a.js', `export const key = "${SECRET}";`],
  ['root/../escaped.txt', 'should never be written'],
  ['root/.env', `AWS_ACCESS_KEY_ID=${SECRET}`],
  ['root/public/logo.png', '\u0089PNG fake image bytes'],
]);

class FakeGitLab extends GitLabClient {
  async getArchive() {
    return new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archive)); c.close(); } });
  }
}

const base = await mkdtemp(join(tmpdir(), 'gs-snap-'));
const dir = join(base, 'snap');
const tree = {
  ref: 'abc1234def', truncated: false,
  files: ['a.js', '../escaped.txt', '.env', 'public/logo.png'].map((path) => ({ path, size: 30, sha: '', tokens: 10 })),
};
const out = await writeSnapshot({
  forge: 'gitlab', client: new FakeGitLab(nodeEnv), owner: '', repo: 'group/proj', tree,
  selection: { exclude: [], include: [], overrides: {} }, dir,
});

await assert.rejects(access(join(base, 'escaped.txt')), 'traversal entry must not escape');
await assert.rejects(access(join(dir, '.env')), 'env file must not be written');
assert.ok(out.skipped.some((s) => s.includes('escaped.txt')), 'traversal reported');
assert.ok(out.skipped.includes('.env'), 'env file reported');
const a = await readFile(join(dir, 'a.js'), 'utf8');
assert.ok(!a.includes(SECRET), 'secret redacted in written file');
assert.ok(out.redacted >= 1);
await access(join(dir, 'public/logo.png'));
const facts = await readFile(join(dir, '.gitscribe/facts.md'), 'utf8');
assert.match(facts, /\.env/);
assert.deepEqual((await readdir(base)).sort(), ['snap'], 'nothing else created next to the snapshot');
console.log(`ok    snapshot safety (${out.textFiles} text, ${out.images} image, skipped: ${out.skipped.join(', ')})`);
