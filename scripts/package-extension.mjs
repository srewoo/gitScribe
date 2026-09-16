/* Packs packages/extension/dist into an upload-ready Chrome Web Store zip.
   Run: npm run package:chrome   (builds first, then packs)
   Source maps are excluded — the store does not need them and they triple the
   upload size. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'packages/extension/dist');
const outDir = join(root, 'store');

const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
const out = join(outDir, `gitscribe-${manifest.version}-chrome.zip`);

await mkdir(outDir, { recursive: true });
await rm(out, { force: true });
// -X drops the extra macOS attributes; junk files would be flagged on review.
await run('zip', ['-qrX', out, '.', '-x', '*.map', '-x', '.DS_Store'], { cwd: dist });

const { size } = await stat(out);
console.log(`packed ${manifest.name} ${manifest.version} -> ${out.slice(root.length + 1)} (${(size / 1024).toFixed(0)} KB)`);
