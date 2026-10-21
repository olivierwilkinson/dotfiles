#!/usr/bin/env node
// Offline resolution uses the SAME functions as subagent_definition, no spawn.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const extension = process.argv[2];
if (!extension) throw new Error('Usage: node scripts/check-definitions.mjs <pi-subagents-extension checkout>');
const base = join(resolve(extension), 'pi-extension/subagents');
const {__test__: resolver} = await import(pathToFileURL(join(base, 'index.ts')));
const {parseAgentDefinition} = await import(pathToFileURL(join(base, 'frontmatter.ts')));
const {compileObjectSchema, schemaErrors} = await import(pathToFileURL(join(base, 'result-schema.ts')));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const childNames = ['context-leaf', 'decomposition-leaf', 'facet-leaf', 'scope-leaf', 'synthesis-leaf'];
const model = 'fireworks-300k/fireworks:accounts/fireworks/models/glm-5p3-flash';
const files = [join(root, 'agent.md'), ...readdirSync(join(root, 'agents')).filter(f => f.endsWith('.md')).map(f => join(root, 'agents', f))];
for (const file of files) {
  const parsed = parseAgentDefinition(readFileSync(file, 'utf8'), file);
  assert(parsed, `frontmatter failed: ${file}`);
}
console.log(`PASS frontmatter: ${files.length} definitions/bases`);

function closedObjects(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, 'every schema object is closed');
    for (const key of schema.required ?? []) assert(key in schema.properties, `missing required property: ${key}`);
  }
  assert(!('$ref' in schema), 'all schemas must be inlined');
  for (const child of Object.values(schema)) {
    if (Array.isArray(child)) child.forEach(closedObjects);
    else if (child && typeof child === 'object') closedObjects(child);
  }
}

for (const child of [null, ...childNames]) {
  const chain = ['deep-project-researcher', ...(child ? [child] : [])];
  const result = resolver.resolveDefinitionChain(chain);
  assert.equal(result.error, undefined, result.error);
  const def = result.hops.at(-1).def;
  assert.equal(def.model, model);
  assert.deepEqual(def.models, [model]);
  assert.equal(def.sessionMode, 'lineage-only');
  assert.equal(def.spawning, child ? false : 'own');
  const tools = new Set(def.tools.split(/[,\s]+/));
  assert(!tools.has('write') && !tools.has('edit'));
  if (!child || child === 'synthesis-leaf' || child === 'decomposition-leaf') {
    assert(![...tools].some(t => t.startsWith('lmtools_') || t.startsWith('tool_gateway_')));
  }
  for (const field of ['argsSchema', 'resultSchema']) {
    closedObjects(def[field]);
    compileObjectSchema(def[field], field);
  }
  const description = resolver.describeDefinitionChain(chain.join(' '));
  assert(!description.error);
  if (child) assert.match(description.text, /none — spawning: false, leaf worker/);
  else {
    assert.equal(def.maxChildren, 16);
    assert.equal(def.maxConcurrent, 3);
    const roster = description.text.split('roster (what deep-project-researcher can spawn):')[1];
    for (const name of childNames) assert(roster.includes(`• ${name} `));
    assert.equal((roster.match(/^• /gm) ?? []).length, 5);
  }
  console.log(`PASS resolution + schemas: ${chain.join(' ')} | model=${model} | spawning=${def.spawning} | tools=${def.tools}`);
  if (process.env.DPR_FULL_RESOLUTION === '1') console.log(description.text);

  if (child) {
    const args = {runId: 'synthetic', ledgerPath: join(homedir(), '.pi/agent/dpr-runs/synthetic.json'), ticket: 't1',
      role: child.replace('-leaf', ''), vaultIdentity: 'not-fetched', proposalRefs: ['not-fetched'], designRefs: [], worldCwds: [],
      asOf: '2026-10-21T00:00:00Z', scopeText: '', scopeDigest: '', approvalRef: '', cells: [], sourceGrants: [],
      priorReports: [], publicOnly: true, privateChannelIds: [], rawFallbackPrefixes: []};
    const compiled = compileObjectSchema(def.argsSchema, 'argsSchema');
    assert.deepEqual(schemaErrors(compiled, args), []);
    assert(schemaErrors(compiled, {...args, unwanted: true}).length);
    assert(schemaErrors(compiled, {...args, role: 'coordinator'}).length);
    const output = {role: args.role, status: 'ready', markdown: '', stories: [], dispatches: [], findings: [], sources: [],
      coverage: [], gaps: [], scopeDeltas: [], jointRequest: {needed: false, cells: [], reportRefs: [], conflicts: [], question: ''},
      budget: {runId: 'synthetic', ticket: 't1', ledgerPath: args.ledgerPath, usedUsd: 0, nextThresholdUsd: 100, pulls: 0, stopped: false}};
    assert.deepEqual(schemaErrors(compileObjectSchema(def.resultSchema, 'resultSchema'), output), []);
  }
}
console.log('PASS: no agent spawned, no source retrieval, no pilot executed');
