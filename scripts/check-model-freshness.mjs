/**
 * Registry freshness (IMP-14). Fails when an entry has aged out, or when an
 * unverified entry states a confident context window. Offline: it reads the
 * committed registry, it does not call any vendor site — a local build must
 * not depend on a live website.
 */
import { MODEL_REGISTRY, staleEntries } from '../packages/core/dist/index.js';

const MAX_AGE_DAYS = 90;

console.log('model                          context     price in/out   provenance    checked');
for (const m of MODEL_REGISTRY) {
  const ctx = m.contextTokens === null ? 'unknown' : m.contextTokens.toLocaleString();
  const price =
    m.pricePerMTokIn === undefined ? 'unknown' : `$${m.pricePerMTokIn}/$${m.pricePerMTokOut}`;
  console.log(
    `${m.id.padEnd(30)} ${ctx.padStart(9)}   ${price.padEnd(13)} ${m.provenance.padEnd(13)} ${m.verifiedOn}`,
  );
}

const issues = staleEntries(MAX_AGE_DAYS);
if (issues.length > 0) {
  console.error('\nRegistry needs attention:');
  for (const i of issues) console.error(`  ${i.id}: ${i.reason}`);
  console.error(
    `\nRe-check each against its sourceUrl and update verifiedOn, or set contextTokens to null.`,
  );
  process.exit(1);
}
console.log(`\nAll ${MODEL_REGISTRY.length} entries within ${MAX_AGE_DAYS} days and self-consistent.`);
