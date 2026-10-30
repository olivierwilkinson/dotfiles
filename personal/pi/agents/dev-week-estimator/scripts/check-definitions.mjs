#!/usr/bin/env node
// Offline resolution uses the SAME functions as subagent_definition, no spawn.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Default to the installed checkout; an explicit argument supports other installs.
const extension = process.argv[2] ?? join(
  homedir(), '.pi/agent/git/github.com/olivierwilkinson/pi-subagents-extension',
);
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
  'audit-leaf',
  'backtest-leaf',
  'calibration-leaf',
  'estimate-leaf',
];
const roleFor = (child) => child.replace('-leaf', '');
const thinkModel = 'anthropic-250k-prefer-using-this-one/claude-opus-5-5';
const model =
  'fireworks-300k/fireworks:accounts/fireworks/models/deepseek-v4p1-flash-1017';
const modelFor = (child) => (child === 'audit-leaf' ? thinkModel : model);

const files = [
  join(root, 'agent.md'),
  join(root, 'agents/_base.md'),
  ...readdirSync(join(root, 'agents'))
    .filter((f) => f.endsWith('.md') && f !== '_base.md')
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
  const chain = ['dev-week-estimator', ...(child ? [child] : [])];
  const result = resolver.resolveDefinitionChain(chain);
  assert.equal(result.error, undefined, result.error);
  const def = result.hops.at(-1).def;
  assert.equal(def.model, modelFor(child));
  assert.deepEqual(def.models, [modelFor(child)]);
  assert.equal(def.sessionMode, 'lineage-only');
  assert.equal(def.spawning, child ? false : 'own');
  const tools = new Set(def.tools.split(/[,\s]+/));
  assert(!tools.has('write') && !tools.has('edit'));
  if (!child || child !== 'calibration-leaf') {
    // estimate/audit/backtest and the coordinator carry no retrieval beyond
    // read/bash; only calibration-leaf may run bash (bounded git).
    assert(!tools.has('codemode'));
    assert(![...tools].some((t) => t.startsWith('lmtools_')));
    assert(![...tools].some((t) => t.startsWith('tool_gateway_')));
  }
  if (child && child !== 'calibration-leaf') {
    assert(!tools.has('bash'), `${child} must be zero-shell`);
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
    assert.equal(def.maxChildren, 12);
    assert.equal(def.maxConcurrent, 4);
    const roster = description.text.split(
      'roster (what dev-week-estimator can spawn):',
    )[1];
    for (const name of childNames) assert(roster.includes(`• ${name} `));
    assert.equal((roster.match(/^• /gm) ?? []).length, 4);
  }
  console.log(
    `PASS resolution + schemas: ${chain.join(' ')} | model=${def.model} | spawning=${def.spawning} | tools=${def.tools}`,
  );

  if (child) {
    const args = {
      runId: 'synthetic',
      ticket: 't1',
      role: roleFor(child),
      dossierRef: '/tmp/dossier.json',
      dossierDigest: 'deadbeef',
      asOf: '2026-10-29T00:00:00Z',
      artifactRoot: '/tmp/estimator-artifacts',
      calibrationRef: '/tmp/calib.json',
      estimateRef: '/tmp/estimate.json',
      issuesRef: '/tmp/estimator-artifacts/synthetic-issues.md',
      comparatorRef: '/tmp/register.json',
      targetZones: ['areas/clients/admin-web'],
      intakeApprovalRef: 'human:synthetic',
      phaseBudgetUsd: 5,
    };
    const compiled = compileObjectSchema(def.argsSchema, 'argsSchema');
    assert.deepEqual(schemaErrors(compiled, args), []);
    const {issuesRef: omitted, ...withoutIssuesRef} = args;
    assert(schemaErrors(compiled, withoutIssuesRef).length);
    assert(schemaErrors(compiled, {...args, issuesRef: 42}).length);
    assert.equal(
      schemaErrors(compiled, {...args, issuesRef: ''}).length === 0,
      child !== 'audit-leaf',
      'audit requires a materialized register ref; earlier phases allow empty',
    );
    assert(schemaErrors(compiled, {...args, unwanted: true}).length);
    assert(schemaErrors(compiled, {...args, role: 'coordinator'}).length);
    assert(
      schemaErrors(compiled, {...args, phaseBudgetUsd: 0}).length,
      'phaseBudgetUsd must be positive',
    );
  }

  const compiledResult = compileObjectSchema(def.resultSchema, 'resultSchema');
  const rejects = (value, message) =>
    assert(schemaErrors(compiledResult, value).length, message);
  if (!child) {
    const result = {
      runId: 'synthetic', status: 'awaiting_intake_approval',
      intakeDigest: 'deadbeef', estimateRef: '', issuesRef: '', markdown: '',
      childReports: [], observedUsd: 0, limitations: [],
    };
    assert.deepEqual(schemaErrors(compiledResult, result), []);
    const {issuesRef, ...withoutRef} = result;
    rejects(withoutRef, 'coordinator must require issuesRef even before output');
    rejects({...result, issuesRef: 42}, 'issuesRef must be a string');
  } else {
    const result = {
      role: roleFor(child), status: 'ready', markdown: '',
      issuesRef: child === 'estimate-leaf' ? '/tmp/synthetic-issues.md' : '',
      issuesMarkdown: child === 'estimate-leaf' ? '# Synthetic issues' : '',
      issuesChecks: [], zoneRates: [], branchTree: [], tasks: [], prPlan: [],
      conditionsRegister: [], knownUnknowns: [], amendments: [],
      backtestScores: [], gaps: [],
      budget: {runId: 'synthetic', ticket: 't1', commands: 0, stopped: false},
    };
    assert.deepEqual(schemaErrors(compiledResult, result), []);
    for (const key of ['issuesRef', 'issuesMarkdown', 'issuesChecks']) {
      const invalid = {...result};
      delete invalid[key];
      rejects(invalid, `${child} requires ${key}`);
    }
    rejects({...result, issuesRef: 42}, 'issuesRef must be a string');
    rejects({...result, issuesMarkdown: []}, 'issuesMarkdown must be a string');
    if (child === 'estimate-leaf') {
      rejects({...result, issuesRef: ''}, 'estimate must name the register');
      rejects({...result, issuesMarkdown: ''}, 'estimate must supply its content');
      // Synthetic structure only, not a sourced estimate or a pilot.
      const task = {
        id: 'T1', issueTitle: 'Change fixture', requirementAnchor: 'US-1 L1',
        evidence: [{quote: 'literal fixture', sourceRef: '/tmp/dossier.md',
          locator: 'L1', upstreamAnchor: ''}],
        branchBands: [{branchId: 'B1', bandId: 'base', conditions: [],
          estimateWorking: 'Synthetic working placeholder for schema tests'}],
        dependsOn: [], sourceClass: 'C1', instanceAnchor: 'fixture:1',
        seam: 'fixture', change: 'synthetic', epicId: 'E1',
        directDays: 1, fullDays: 2, prId: 'PR1', confidence: 'low',
      };
      assert.deepEqual(schemaErrors(compiledResult, {...result, tasks: [task]}), []);
      const rejectsTask = (t, message) => rejects({...result, tasks: [t]}, message);
      for (const key of ['issueTitle', 'requirementAnchor', 'evidence', 'branchBands', 'dependsOn']) {
        const invalid = {...task};
        delete invalid[key];
        rejectsTask(invalid, `task requires ${key}`);
      }
      rejectsTask({...task, evidence: []}, 'task needs evidence');
      for (const key of ['quote', 'sourceRef', 'locator']) {
        rejectsTask({...task, evidence: [{...task.evidence[0], [key]: ''}]},
          `task needs nonempty ${key}`);
      }
      rejectsTask({...task, branchBands: []}, 'task needs membership');
      rejectsTask({...task, branchBands: [{...task.branchBands[0], estimateWorking: ''}]},
        'task needs estimate working');
      rejectsTask({...task, dependsOn: [42]}, 'dependency IDs must be strings');
    }
    if (child === 'audit-leaf') {
      const issuesChecks = ['evidence_quotes', 'estimate_arithmetic', 'band_reconciliation']
        .map((check) => ({check, outcome: 'pass', details: 'Synthetic coverage'}));
      assert.deepEqual(schemaErrors(compiledResult, {...result, issuesChecks}), []);
      // A failure is reportable, not a schema violation; the readiness gate rejects it.
      assert.deepEqual(schemaErrors(compiledResult, {...result,
        status: 'partial_due_to_gap',
        issuesChecks: [{...issuesChecks[0], outcome: 'fail'}]}), []);
      rejects({...result, issuesChecks: [{...issuesChecks[0], check: 'unchecked'}]},
        'only the three named checks are allowed');
      rejects({...result, issuesChecks: [{...issuesChecks[0], outcome: 'skip'}]},
        'checks cannot silently skip');
      rejects({...result, issuesChecks: [{...issuesChecks[0], details: ''}]},
        'checks need concrete details');
    }
  }
  console.log(`PASS issues-register contract fixtures: ${chain.join(' ')}`);
}

// Coordinator args/result compile closed too (already looped as child=null).
console.log('PASS: no agent spawned, no retrieval performed, no pilot run');
