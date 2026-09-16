import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  sourcemap: true,
  logLevel: 'info',
};

const ctx = await esbuild.context({
  ...common,
  entryPoints: { background: 'src/background.ts', sidepanel: 'src/sidepanel.ts' },
  outdir: 'dist',
  splitting: true,   // keeps the lazily-imported SDK out of the worker's main chunk
});

await cp('manifest.json', 'dist/manifest.json');
await cp('src/sidepanel.html', 'dist/sidepanel.html');
await cp('src/sidepanel.css', 'dist/sidepanel.css');
await cp('icons', 'dist/icons', {
  recursive: true,
  filter: (src) => !src.endsWith('.svg'),   // sources stay out of the bundle
}).catch(() => {});

if (watch) { await ctx.watch(); } else { await ctx.rebuild(); await ctx.dispose(); }
console.log('extension built -> packages/extension/dist');
