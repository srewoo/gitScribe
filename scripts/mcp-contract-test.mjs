/**
 * MCP contract test. Deterministic and offline: it starts the server over
 * stdio and checks the advertised tool surface. No API keys, no network.
 *
 * The point is that a rename or a dropped tool fails CI rather than silently
 * breaking every client.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';

const EXPECTED = {
  gitscribe_tree: ['repo'],
  gitscribe_digest: ['repo'],
  gitscribe_estimate: ['repo'],
  gitscribe_plan_parts: ['repo', 'maxTokens'],
  gitscribe_diff: ['repo', 'spec'],
  gitscribe_readme_guide: ['repo'],
  gitscribe_readme_chunk: ['repo', 'part'],
  gitscribe_verify_readme: ['repo', 'markdown'],
  gitscribe_diagram: ['repo'],
  gitscribe_snapshot: ['repo'],
  gitscribe_models: [],
};

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../packages/mcp/dist/server.js', import.meta.url).pathname],
});
const client = new Client({ name: 'contract-test', version: '1' });
await client.connect(transport);

const { tools } = await client.listTools();
const byName = new Map(tools.map((t) => [t.name, t]));
let failures = 0;

for (const [name, required] of Object.entries(EXPECTED)) {
  const tool = byName.get(name);
  if (!tool) {
    console.error(`FAIL  ${name} is not registered`);
    failures++;
    continue;
  }
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const missing = required.filter((r) => !props.includes(r));
  if (missing.length > 0) {
    console.error(`FAIL  ${name} missing input(s): ${missing.join(', ')}`);
    failures++;
    continue;
  }
  if (!tool.description || tool.description.length < 20) {
    console.error(`FAIL  ${name} has no usable description`);
    failures++;
    continue;
  }
  console.log(`ok    ${name}`);
}

for (const name of byName.keys()) {
  if (!(name in EXPECTED)) {
    console.error(`FAIL  ${name} is registered but not in the contract — add it to EXPECTED`);
    failures++;
  }
}

// A tool that needs a repo must reject a malformed one without touching the
// network. The SDK surfaces a tool-side throw as isError content rather than a
// rejected promise, so accept either shape.
const bad = await client
  .callTool({ name: 'gitscribe_tree', arguments: { repo: 'not-a-repo' } })
  .then((r) => ({ rejected: r?.isError === true, detail: r }))
  .catch(() => ({ rejected: true, detail: 'threw' }));
assert.ok(bad.rejected, `a malformed repo must be rejected, got: ${JSON.stringify(bad.detail).slice(0, 160)}`);
console.log('ok    malformed repo rejected');

const { prompts } = await client.listPrompts();
const promo = prompts.find((p) => p.name === 'promo');
if (!promo || !promo.arguments?.some((a) => a.name === 'repo' && a.required)) {
  console.error('FAIL  promo prompt missing or does not require repo');
  failures++;
} else {
  const msg = await client.getPrompt({ name: 'promo', arguments: { repo: 'srewoo/paintBrush' } });
  assert.match(msg.messages[0].content.text, /gitscribe_snapshot[\s\S]*\/brag/);
  assert.match(msg.messages[0].content.text, /If no \/brag skill is available/, 'promo explains what to do without brag');
  console.log('ok    promo prompt');
}

await client.close();

if (failures > 0) {
  console.error(`\n${failures} contract failure(s).`);
  process.exit(1);
}
console.log(`\nMCP contract: ${Object.keys(EXPECTED).length} tools verified.`);
