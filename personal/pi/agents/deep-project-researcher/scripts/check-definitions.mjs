#!/usr/bin/env node
// Offline resolution uses the SAME functions as subagent_definition, no spawn.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const extension =
  process.argv[2] ??
  join(homedir(), '.pi/agent/git/github.com/olivierwilkinson/pi-subagents-extension');
const base = join(resolve(extension), 'pi-extension/subagents');
const {__test__: resolver} = await import(
  pathToFileURL(join(base, 'index.ts'))
);
const {parseAgentDefinition} = await import(
  pathToFileURL(join(base, 'frontmatter.ts'))
);
const {compileObjectSchema, schemaErrors} = await import(
  pathToFileURL(join(base, 'result-schema.ts'))
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const childNames = [
  'code-sweep-leaf',
  'decomposition-leaf',
  'enumerate-leaf',
  'facet-leaf',
  'scope-leaf',
  'slack-leaf',
  'synthesis-leaf',
  'think-leaf',
  'vault-leaf',
];
const roleFor = (child) =>
  child === 'code-sweep-leaf' ? 'code_sweep' : child.replace('-leaf', '');
const thinkModel = 'anthropic-250k-prefer-using-this-one/claude-opus-5-5';
const modelFor = (child) => (child === 'think-leaf' ? thinkModel : model);
const model =
  'fireworks-300k/fireworks:accounts/fireworks/models/deepseek-v4p1-flash-1017';
const loopChildren = new Set([
  'vault-leaf',
  'slack-leaf',
  'code-sweep-leaf',
  'facet-leaf',
]);
const loopPhaseFor = (child) => (child === 'facet-leaf' ? 'deep' : 'scoping');
const noRetrievalChildren = new Set([
  'decomposition-leaf',
  'enumerate-leaf',
  'synthesis-leaf',
  'think-leaf',
  'code-sweep-leaf',
]);
// scope-leaf is zero-SOURCE-retrieval but may call lmtools_code_interest_list
// (registry/catalogue listing only) for catalogue-first interests selection.
const allowedRegistryList = new Set(['scope-leaf']);
const files = [
  join(root, 'agent.md'),
  ...readdirSync(join(root, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(root, 'agents', f)),
];
for (const file of files) {
  const parsed = parseAgentDefinition(readFileSync(file, 'utf8'), file);
  assert(parsed, `frontmatter failed: ${file}`);
}
console.log(`PASS frontmatter: ${files.length} definitions/bases`);

function closedObjects(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(
      schema.additionalProperties,
      false,
      'every schema object is closed',
    );
    for (const key of schema.required ?? [])
      assert(key in schema.properties, `missing required property: ${key}`);
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
  assert.equal(def.model, modelFor(child));
  assert.deepEqual(def.models, [modelFor(child)]);
  assert.equal(def.sessionMode, 'lineage-only');
  assert.equal(def.spawning, child ? false : 'own');
  const tools = new Set(def.tools.split(/[,\s]+/));
  assert(!tools.has('write') && !tools.has('edit'));
  if (!child || noRetrievalChildren.has(child)) {
    assert(
      ![...tools].some(
        (t) =>
          (t.startsWith('lmtools_') &&
            !(
              allowedRegistryList.has(child) &&
              (t === 'lmtools_code_interest_list' ||
                t === 'lmtools_code_interest_generate')
            )) ||
          t.startsWith('tool_gateway_') ||
          t === 'codemode',
      ),
    );
  }
  for (const field of ['argsSchema', 'resultSchema']) {
    closedObjects(def[field]);
    compileObjectSchema(def[field], field);
  }
  const description = resolver.describeDefinitionChain(chain.join(' '));
  assert(!description.error);
  if (child)
    assert.match(description.text, /none — spawning: false, leaf worker/);
  else {
    assert.equal(def.maxChildren, 60);
    assert.equal(def.maxConcurrent, 5);
    const roster = description.text.split(
      'roster (what deep-project-researcher can spawn):',
    )[1];
    for (const name of childNames) assert(roster.includes(`• ${name} `));
    assert.equal((roster.match(/^• /gm) ?? []).length, 9);
  }
  console.log(
    `PASS resolution + schemas: ${chain.join(' ')} | model=${def.model} | spawning=${def.spawning} | tools=${def.tools}`,
  );
  if (process.env.DPR_FULL_RESOLUTION === '1') console.log(description.text);

  if (child) {
    const args = {
      runId: 'synthetic',
      ledgerPath: join(homedir(), '.pi/agent/dpr-runs/synthetic.json'),
      ticket: 't1',
      role: roleFor(child),
      vaultIdentity: 'not-fetched',
      proposalRefs: ['not-fetched'],
      designRefs: [],
      asOf: '2026-10-21T00:00:00Z',
      scopeText: '',
      scopeDigest: '',
      approvalRef: '',
      cells: [],
      sourceGrants: [],
      priorReports: [],
      publicOnly: true,
      privateChannelIds: [],
      rawFallbackPrefixes: [],
    };
    if (loopChildren.has(child)) args.loopPhase = loopPhaseFor(child);
    const compiled = compileObjectSchema(def.argsSchema, 'argsSchema');
    assert.deepEqual(schemaErrors(compiled, args), []);
    assert(schemaErrors(compiled, {...args, unwanted: true}).length);
    assert(schemaErrors(compiled, {...args, role: 'coordinator'}).length);
    if (!loopChildren.has(child))
      assert.deepEqual(
        schemaErrors(compiled, {...args, loopPhase: 'deep'}),
        [],
      );
    assert(
      schemaErrors(compiled, {...args, loopPhase: 'bogus'}).length,
      'loopPhase enum must be enforced',
    );
    const output = {
      role: args.role,
      status: 'ready',
      markdown: '',
      stories: [],
      dispatches: [],
      findings: [],
      sources: [],
      coverage: [],
      gaps: [],
      scopeDeltas: [],
      jointRequest: {
        needed: false,
        cells: [],
        reportRefs: [],
        conflicts: [],
        question: '',
      },
      budget: {
        runId: 'synthetic',
        ticket: 't1',
        ledgerPath: args.ledgerPath,
        usedUsd: 0,
        nextThresholdUsd: 100,
        pulls: 0,
        stopped: false,
      },
    };
    if (loopChildren.has(child)) {
      output.loop = {
        recommendation: 'loop_again',
        rationale: 'named leads remain',
        newFindings: 3,
        knownFindings: 5,
        nextProbes: ['vault_get_project 49546'],
      };
      output.unexploredEntries = [
        {
          question: 'which teams own the host shell?',
          whyUnexplored: 'convergence_stopped',
          wouldAnswer: ['US-01:clarifies'],
          nextProbe: 'vault list members for project 49546',
          estPulls: 2,
        },
      ];
    }
    assert.deepEqual(
      schemaErrors(
        compileObjectSchema(def.resultSchema, 'resultSchema'),
        output,
      ),
      [],
    );
    if (loopChildren.has(child)) {
      assert(
        schemaErrors(compileObjectSchema(def.resultSchema, 'resultSchema'), {
          ...output,
          loop: {...output.loop, recommendation: 'maybe'},
        }).length,
      );
    }
  }
}
console.log('PASS: no agent spawned, no source retrieval, no pilot executed');
