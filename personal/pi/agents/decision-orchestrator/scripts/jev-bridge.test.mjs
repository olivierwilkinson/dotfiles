// Bridge-local fold regressions. Run with JEV_SUBAGENTS_PATH pointing at the
// candidate extension's pi-extension/subagents directory, never the installed copy:
// JEV_SUBAGENTS_PATH=/path/to/extension/pi-extension/subagents node --test jev-bridge.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

if (!process.env.JEV_SUBAGENTS_PATH) {
  throw new Error("Set JEV_SUBAGENTS_PATH to the candidate extension; installed fallback forbidden");
}
process.env.JEV_BRIDGE_NO_BOOT = "1";
const { emptyReceipts, foldEvents, buildRequest, mapAnswers, mergedWorkers } = await import("./jev-bridge.mjs");
const { createJiti } = await import("@mariozechner/jiti");
const jiti = createJiti(import.meta.url);
const sharedPath = (name) => join(process.env.JEV_SUBAGENTS_PATH, name);
const { pendingStatusReconciliations, recordReconciliationPending, statusReconciliationOperationId } =
  await jiti.import(sharedPath("status-reconciliation.ts"));
const { loadOrchReceipts } = await jiti.import(sharedPath("orchestration-journal.ts"));

function fixture(t, state = "killed", recoveryCause) {
  const dir = mkdtempSync(join(tmpdir(), "jev-bridge-fold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, "");
  const receipts = emptyReceipts();
  receipts.lifecycle.old = {
    childId: "old", state, stateTs: 1, name: "Worker", purpose: "work",
    sessionFile, attempt: 1, taskIds: [7],
    ...(recoveryCause ? { recoveryCause } : {}),
  };
  return { dir, sessionFile, receipts };
}

function resume(receipts, sessionPath) {
  return foldEvents(receipts, [
    { type: "decision", calls: [{ id: "resume", tool: "subagent_resume", args: { sessionPath } }] },
    { type: "tool_result", callId: "resume", tool: "subagent_resume", output: "resumed",
      details: { id: "new", status: "started" } },
  ]);
}

function captureWarnings(t) {
  const warnings = [];
  t.mock.method(process.stderr, "write", (message) => { warnings.push(String(message)); return true; });
  return warnings;
}

function loopingPath(dir) {
  const path = join(dir, "loop.jsonl");
  symlinkSync(path, path);
  assert.throws(() => realpathSync(path), { code: "ELOOP" });
  return path;
}

function assertUnmatched(receipts) {
  assert.equal(receipts.lifecycle.new, undefined);
  assert.equal(receipts.lifecycle.old.resumedBy, undefined);
  assert.equal(receipts.operations["control:resume"].effect, undefined);
  assert.equal(receipts.operations["control:resume"].acknowledgement.infraIssue, true);
  assert.match(receipts.operations["control:resume"].acknowledgement.error, /unambiguous lifecycle target/);
}

describe("bridge resume acknowledgement fold", () => {
  for (const [cause, eligible] of [
    ["K1-auth", true], ["K1-provider", true], ["K4", true],
    ["K1-overflow", false], ["K2", false], ["K3", false], [undefined, false],
  ]) {
    it(`killed + ${cause ?? "no cause"} ${eligible ? "resumes" : "cannot resume"}`, (t) => {
      const { receipts, sessionFile } = fixture(t, "killed", cause);
      assert.equal(resume(receipts, sessionFile), true);
      const operation = receipts.operations["control:resume"];
      if (eligible) {
        assert.equal(operation.acknowledgement.infraIssue, undefined);
        assert.equal(operation.effect.childId, "old");
        assert.equal(receipts.lifecycle.old.resumedBy, "new");
        assert.equal(receipts.lifecycle.new.state, "resumed");
        assert.equal(receipts.lifecycle.new.resumedFrom, "old");
        assert.equal(receipts.lifecycle.new.attempt, 2);
        assert.deepEqual(receipts.lifecycle.new.taskIds, [7]);
        const folded = structuredClone(receipts);
        assert.equal(resume(receipts, sessionFile), false, "acknowledgement replay has no effects");
        assert.deepEqual(receipts, folded);
      } else {
        assert.equal(receipts.lifecycle.new, undefined);
        assert.equal(receipts.lifecycle.old.resumedBy, undefined);
        assert.equal(operation.effect, undefined);
        assert.equal(operation.acknowledgement.infraIssue, true);
        assert.match(operation.acknowledgement.error, /eligible old row/);
      }
    });
  }

  it("still matches canonical symlinks for exited-without-done rows", (t) => {
    const { receipts, dir, sessionFile } = fixture(t, "exited-without-done");
    const alias = join(dir, "alias.jsonl");
    symlinkSync(sessionFile, alias);
    resume(receipts, alias);
    assert.equal(receipts.lifecycle.old.resumedBy, "new");
  });

  it("does not guess an unrelated sole exited transcript", (t) => {
    const { receipts, dir } = fixture(t, "exited-without-done");
    resume(receipts, join(dir, "unrelated.jsonl"));
    assertUnmatched(receipts);
  });

  it("notifies and fails closed when the requested path cannot be canonicalized", (t) => {
    const { receipts, dir } = fixture(t, "exited-without-done");
    const path = loopingPath(dir);
    const warnings = captureWarnings(t);
    assert.doesNotThrow(() => resume(receipts, path));
    assertUnmatched(receipts);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /jev-bridge:.*canonical.*ELOOP/);
    assert.ok(warnings[0].includes(path));
  });

  it("skips an unreadable row but still matches another canonical transcript", (t) => {
    const { receipts, dir, sessionFile } = fixture(t, "exited-without-done");
    const path = loopingPath(dir);
    receipts.lifecycle = { bad: { ...receipts.lifecycle.old, childId: "bad", sessionFile: path }, ...receipts.lifecycle };
    const warnings = captureWarnings(t);
    assert.doesNotThrow(() => resume(receipts, sessionFile));
    assert.equal(receipts.lifecycle.bad.resumedBy, undefined);
    assert.equal(receipts.lifecycle.old.resumedBy, "new");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /jev-bridge:.*canonical.*ELOOP/);
  });

  it("never matches two failed canonicalizations, even for identical raw paths", (t) => {
    const { receipts, dir } = fixture(t, "exited-without-done");
    const path = loopingPath(dir);
    receipts.lifecycle.old.sessionFile = path;
    const warnings = captureWarnings(t);
    assert.doesNotThrow(() => resume(receipts, path));
    assertUnmatched(receipts);
    assert.ok(warnings.length > 0);
  });
});

// P5 semantics (v6): status-scout pairing, reconciliation over the authoritative
// task tree, and inbox-hold reopen — ported from the extension-side jev-bridge
// test suite. Bridge-level assertions only (spawn slots, purposes, revisions);
// the materializer's materialized args live extension-side.
function p5Tools(...names) {
  return names.map((name) => ({name, description: name, parameters: {type: "object", properties: {}}}));
}
const P5_ORCH_TOOLS = () => p5Tools("subagent", "subagent_done", "subagent_ask_child", "subagent_answer_child");
function p5Request(events, opts = {}) {
  return {
    v: 1,
    capabilities: {completionKind: true},
    agent: {id: "s1", name: "orchestrator", agentType: "decision-orchestrator", cwd: "/work",
      ...(opts.sessionFile ? {sessionFile: opts.sessionFile} : {})},
    instructions: "orchestrate",
    tools: opts.tools ?? P5_ORCH_TOOLS(),
    roster: [{name: "scout", description: "Read-only checking."},
      {name: "worker", description: "General doing."}],
    events,
    state: {
      inboxDecisions: [],
      taskTree: "tree" in opts ? opts.tree : {ok: true, revision: 3, tasks: [P5_TASK], legacyRootIds: []},
      ...(opts.taskUpdates ? {sessionMessages: {taskUpdates: opts.taskUpdates}} : {}),
    },
  };
}
const P5_TASK = {id: 7, text: "Write the widget docs", status: "open", stream: 2, revision: 2,
  source: "session", ts: 1, updatedTs: 1};
function p5ChildEvents(dir) {
  return [
    {type: "decision", say: "Spawning.", calls: [{id: "c1", tool: "subagent",
      args: {name: "Worker 1", agent: "worker", task: "do the work"}}]},
    {type: "tool_result", tool: "subagent", callId: "c1", output: "Spawned.", isError: false,
      details: {id: "child-1", sessionFile: join(dir, "child.jsonl")}},
    {type: "notification", kind: "subagent_result", source: "subagent_result",
      text: 'Sub-agent "Worker 1" finished.',
      payload: {id: "child-1", name: "Worker 1", completionKind: "completed", resultStorePath: join(dir, "child-report.md")}},
  ];
}
let p5ScoutSeq = 0;
function p5ScoutEvents(dir, report) {
  const scoutReportPath = join(dir, `scout-report-${++p5ScoutSeq}.md`);
  writeFileSync(scoutReportPath, report);
  return [
    {type: "decision", say: "Scouting.", calls: [{id: "c2", tool: "subagent",
      args: {name: "Task 7 status scout", agent: "scout", purpose: "status_scout",
        spawnSlot: "status-scout:child-1:7", reconciliationOperationId: "status-reconcile:child-1:7"}}]},
    {type: "tool_result", tool: "subagent", callId: "c2", output: "Spawned.", isError: false,
      details: {id: "scout-1", sessionFile: join(dir, "scout.jsonl")}},
    {type: "notification", kind: "subagent_result", source: "subagent_result",
      text: 'Sub-agent "Task 7 status scout" finished.',
      payload: {id: "scout-1", name: "Task 7 status scout", completionKind: "completed", resultStorePath: scoutReportPath}},
  ];
}
function p5Pending(dir, sessionFile, events, opts = {}) {
  const marked = recordReconciliationPending(sessionFile,
    [{childId: "child-1", taskId: 7, revision: 3, taskRevision: 2, reportPath: join(dir, "child-report.md")}]);
  assert.ok(marked.ok);
  writeFileSync(join(dir, "child-report.md"), "Worker 1 report: docs NOT finished.");
  return p5Request(events, {sessionFile, ...opts});
}

describe("bridge P5 status scout reconciliation (v6)", () => {
  it("marks a completed child's unclosed task and dispatches ONE status scout slot, never a writer and never the task", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const req = p5Pending(dir, sessionFile, p5ChildEvents(dir));
    const state = buildRequest(req).state;
    assert.deepEqual(state.pending_reconciliations, [{child_id: "child-1", task_id: 7, revision: 3,
      task_status: "open", task_text: "Write the widget docs", report_path: join(dir, "child-report.md")}]);
    const mapped = mapAnswers({done: {noul: 0.1}, next_action: {choice: "wait"}}, req);
    assert.equal(mapped.calls[0].tool, "subagent");
    assert.equal(mapped.calls[0].args.purpose, "status_scout");
    assert.equal(mapped.calls[0].args.agent, "scout", "a read-only scout definition scouts, never a writer");
    assert.equal(mapped.calls[0].spawn.slot, "status-scout:child-1:7", "the spawn slot binds scout to (child, task)");
    assert.match(mapped.calls[0].reason, /status-reconcile:child-1:7/);
    // One dispatch per mark: a replayed fold never duplicates the spawn.
    const replay = mapAnswers({done: {noul: 0.1}, next_action: {choice: "wait"}}, req);
    assert.equal(replay.calls[0]?.spawn?.slot, "status-scout:child-1:7");
  });

  it("exited-without-done orphans never spawn status scouts (lifecycle recovery owns them)", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const events = p5ChildEvents(dir).slice(0, 2);
    events.push({type: "notification", kind: "subagent_result", source: "subagent_result",
      text: "ended without done", payload: {id: "child-1", name: "Worker 1", completionKind: "exited-without-done"}});
    const mapped = mapAnswers({done: {noul: 0}, next_action: {choice: "wait"}},
      p5Pending(dir, sessionFile, events));
    assert.notEqual(mapped.calls?.[0]?.tool, "subagent");
    assert.notEqual(mapped.calls?.[0]?.tool, "task");
  });

  it("a done verdict auto-completes through the task service with the scout report as the evidence ref", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const req = p5Pending(dir, sessionFile,
      [...p5ChildEvents(dir), ...p5ScoutEvents(dir, 'Evidence: docs committed.\n\n```json\n{"status": "done"}\n```')],
      {tools: p5Tools("subagent", "subagent_done", "task_update")});
    const mapped = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"}}, req);
    assert.equal(mapped.calls[0].tool, "task_update");
    assert.equal(mapped.calls[0].args.updates[0].complete, true);
    assert.equal(mapped.calls[0].args.updates[0].id, 7);
    assert.match(String(mapped.calls[0].args.updates[0].ref), /scout-report-\d+\.md$/,
      "scout report pointer is the auditable completion ref");
    assert.equal(mapped.terminal, undefined, "the auto-complete runs before any done report");
  });

  it("non-done verdicts never auto-complete; they route a finite task_reconciliation decision (redispatch/escalate)", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    for (const status of ["blocked", "replaced", "in_progress", "open"]) {
      const sessionFile = join(dir, `${status}.jsonl`);
      writeFileSync(sessionFile, "");
      writeFileSync(join(dir, "child-report.md"), "report");
      const req = p5Pending(dir, sessionFile,
        [...p5ChildEvents(dir), ...p5ScoutEvents(dir, `\n\`\`\`json\n{"status": "${status}"}\n\`\`\`\n`)],
        {tools: p5Tools("subagent", "subagent_done", "task", "escalate")});
      const shaped = buildRequest(req);
      assert.equal(shaped.questions.task_reconciliation.type, "choice", `verdict ${status} routes a finite decision`);
      assert.deepEqual(Object.keys(shaped.questions.task_reconciliation.criteria).sort(),
        ["escalate", "redispatch_task"]);
      const redispatch = mapAnswers(
        {done: {noul: 0.9}, next_action: {choice: "report_done"},
          task_reconciliation: {choice: "redispatch_task"}, worker_agent: {choice: "worker"}}, req);
      assert.equal(redispatch.calls[0].tool, "subagent");
      assert.equal(redispatch.calls[0].args.purpose, "work");
      assert.equal(redispatch.calls[0].spawn.slot, "task:7", "redispatch is a worker arm bound to the task");
      const escalationSession = join(dir, `${status}-escalated.jsonl`);
      writeFileSync(escalationSession, "");
      const escalated = mapAnswers(
        {done: {noul: 0.9}, next_action: {choice: "report_done"},
          task_reconciliation: {choice: "escalate"}, worker_agent: {choice: "worker"}},
        p5Pending(dir, escalationSession,
          [...p5ChildEvents(dir), ...p5ScoutEvents(dir, `{"status":"${status}"}`)],
          {tools: p5Tools("subagent", "subagent_done", "escalate")}));
      assert.equal(escalated.calls[0].tool, "escalate");
      assert.match(escalated.calls[0].args.description, new RegExp(`"${status}"`));
    }
  });

  it("a stale done verdict cannot close new scope; a malformed scout report infra-escalates", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    writeFileSync(join(dir, "child-report.md"), "report");
    const staleSession = join(dir, "stale.jsonl");
    writeFileSync(staleSession, "");
    const staleReq = p5Pending(dir, staleSession,
      [...p5ChildEvents(dir), ...p5ScoutEvents(dir, '{"status": "done"}')],
      {tree: {ok: true, revision: 5, tasks: [{...P5_TASK, revision: 5}], legacyRootIds: []},
        tools: p5Tools("subagent", "subagent_done", "task", "escalate")});
    const mapped = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"},
      task_reconciliation: {choice: "escalate"}, worker_agent: {choice: "worker"}}, staleReq);
    assert.notEqual(mapped.calls[0].tool, "task", "stale scout cannot auto-complete");
    assert.equal(mapped.calls[0].tool, "escalate");
    assert.match(mapped.calls[0].args.description, /revision 5/);
    assert.match(mapped.calls[0].args.description, /task revision 2/);

    const malformedSession = join(dir, "malformed.jsonl");
    writeFileSync(malformedSession, "");
    const escalated = mapAnswers({done: {noul: 0}, next_action: {choice: "wait"}},
      p5Pending(dir, malformedSession, [...p5ChildEvents(dir), ...p5ScoutEvents(dir, "I could not verify anything.")],
        {tools: p5Tools("subagent", "subagent_done", "escalate")}));
    assert.equal(escalated.calls[0].tool, "escalate");
    assert.equal(escalated.calls[0].args.infrastructureIssue, true);
    assert.match(escalated.calls[0].args.description, /unusable|\{"status"\}/);
  });

  it("a task the snapshot already shows closed resolves its mark without a scout and never blocks convergence", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const req = p5Pending(dir, sessionFile, p5ChildEvents(dir),
      {tree: {ok: true, revision: 4, tasks: [{...P5_TASK, status: "done"}], legacyRootIds: []}});
    buildRequest(req);
    const mapped = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"}}, req);
    assert.equal(mapped.terminal, true, "converges once reconciliation resolved mechanically");
    const loaded = loadOrchReceipts(sessionFile);
    assert.ok(loaded.ok);
    assert.deepEqual(pendingStatusReconciliations(loaded.receipts), []);
    assert.equal(loaded.receipts.operations[statusReconciliationOperationId("child-1", 7)].reconciled?.detail?.disposition,
      "task already done");
  });

  it("a task-store failure is an error, never an empty reconciliation surface", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const escalated = mapAnswers({done: {noul: 0}, next_action: {choice: "wait"}},
      p5Pending(dir, sessionFile, p5ChildEvents(dir),
        {tree: {ok: false, error: "Task store unavailable"}, tools: p5Tools("subagent", "subagent_done", "escalate")}));
    assert.equal(escalated.calls[0].tool, "escalate");
    assert.equal(escalated.calls[0].args.infrastructureIssue, true);
    assert.match(escalated.calls[0].args.description, /Task store unavailable/);
  });

  it("unresolved reconciliation and in-flight scouts hold convergence", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const events = [...p5ChildEvents(dir), ...p5ScoutEvents(dir, '{"status": "in_progress"}').slice(0, 2)];
    const hold = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"}},
      p5Pending(dir, sessionFile, events));
    assert.equal(hold.terminal, undefined);
    assert.deepEqual(hold.calls, []);
    assert.match(hold.say, /Holding/);
  });

  it("a successful task complete acknowledgement resolves the reconciliation mark durably", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p5-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "");
    const marked = recordReconciliationPending(sessionFile,
      [{childId: "child-1", taskId: 7, revision: 3, taskRevision: 2}]);
    assert.ok(marked.ok);
    const events = [
      {type: "decision", say: "Completing.", calls: [{id: "c9", tool: "task",
        args: {op: "complete", id: 7, ref: "/tmp/scout.md"}}]},
      {type: "tool_result", tool: "task", callId: "c9", output: "Task #7 completed", isError: false,
        details: {op: "complete", id: 7}},
    ];
    mergedWorkers(sessionFile, events, {completionKind: true});
    const loaded = loadOrchReceipts(sessionFile);
    assert.ok(loaded.ok);
    assert.deepEqual(pendingStatusReconciliations(loaded.receipts), []);
    const operation = loaded.receipts.operations[statusReconciliationOperationId("child-1", 7)];
    assert.equal(operation.reconciled?.detail?.disposition, "auto-completed");
    assert.equal(operation.reconciled?.detail?.ref, "/tmp/scout.md");
  });
});

// ─── P7 convergence (v7) ─────────────────────────────────────────────────────
//
// Bridge-side ports of test/convergence-contracts.test.ts and
// test/convergence.test.ts behavior, driven through the real loop:
// buildRequest -> mapAnswers -> provider materialization -> transcript
// acknowledgement -> reload (spec: never merely call the shared helper).
const { materializeDecisionSpawns } = await jiti.import(sharedPath("decision-spawn.ts"));
const conv = await jiti.import(sharedPath("convergence.ts"));
const { createConvergenceServices, convergenceNext, convergenceGate, convergenceSpawnSlots, workFingerprint, taskClosureProblems } = conv;
const { buildForwardBody } = await jiti.import(sharedPath("forward.ts"));
const { readOrchReceipts, saveOrchReceipts, p7PairingProblem, workSnapshot, observeP7Work, foldP7Facts, p7Readiness, resolveP7Forward } =
  await import("./jev-bridge.mjs");
const { spawnSync } = await import("node:child_process");

const P7_ROSTER = [
  {name: "scout", tools: "read,write", cli: "pi"},
  {name: "independent-reader", tools: "read,subagent_done", cli: "pi"},
  {name: "worker"},
  {name: "thinker"},
];
const PASS = {verdict: "pass", evidence: ["tests.log"], findings: []};
const SECTIONS = {evidence: "Evidence", taskOutcomes: "Task outcomes", caveats: "Caveats",
  unresolvedApprovals: "Unresolved approvals", reportIndex: "Report index"};

function p7Fixture(t, opts = {}) {
  p7CallSeq = 0;
  p7ChildSeq = 0;
  const dir = mkdtempSync(join(tmpdir(), "jev-bridge-p7-"));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const sessionFile = join(dir, "parent.jsonl");
  writeFileSync(sessionFile, "");
  writeFileSync(join(dir, "evidence.md"), "widget evidence\n");
  const req = {
    v: 1,
    capabilities: {completionKind: true, completionDecisions: true, convergence: 1},
    agent: {id: "orch-1", name: "orchestrator", agentType: "decision-orchestrator", cwd: dir, sessionFile},
    instructions: "orchestrate",
    tools: ["subagent", "subagent_done", "escalate", "task_update", "apply_decision", "subagent_ask_child", "subagent_answer_child"]
      .map((name) => ({name, description: name, parameters: {type: "object", properties: {}}})),
    roster: opts.roster ?? P7_ROSTER,
    events: [{type: "user_input", text: opts.acceptance ?? "Build the widget exactly."}],
    spawnContexts: opts.spawnContexts ?? [{id: "task:1", purpose: "work", name: "Widget: implement the correction",
      taskText: "Implement the widget", cwd: dir, artifactRoot: dir, lineage: ["root", "orch-1"], taskIds: [1], stream: 2}],
    state: {
      inboxDecisions: [],
      convergence: {v: 1, state: {v: 1, sequence: 0, workRevision: 0, tickets: []}},
      convergenceContext: {cwd: dir, artifactRoot: dir, lineage: ["root", "orch-1"], stream: 2},
      ...(opts.state ?? {}),
      taskTree: "tree" in opts ? opts.tree : {ok: true, revision: 3,
        tasks: [{id: 1, text: "Implement the widget", status: "open", revision: 1, stream: 2}], legacyRootIds: []},
    },
  };
  const treeOverride = "tree" in opts ? opts.tree : undefined;
  req.state.taskTree = {ok: true, revision: 3,
    tasks: [{id: 1, text: "Implement the widget", status: "open", revision: 1, stream: 2}], legacyRootIds: []};
  // Bootstrap the P7 journal exactly as a P7-active session would: one durable
  // observation record through the shared service, so the fixture starts active
  // (empty journals keep the v6 compat path by design).
  if (!(opts.compat === true)) {
    const boot = workSnapshot(req, emptyReceipts());
    if (boot.hold) throw new Error(`fixture bootstrap snapshot failed: ${boot.hold.key}`);
    const service = createConvergenceServices(sessionFile);
    const state = service.observe("bootstrap", boot.snapshot);
    req.state.convergence = {v: 1, state};
  }
  if (treeOverride !== undefined) req.state.taskTree = treeOverride;
  return {dir, sessionFile, req};
}

let p7CallSeq = 0;
let p7ChildSeq = 0;
function appendEntry(sessionFile, entry) {
  writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`, {flag: "a"});
}
/** One real decision turn: build, map, materialize, record the executed calls. */
function p7Drive(req, answers = {}) {
  const built = buildRequest(req);
  const mapped = mapAnswers(answers, req);
  const materialized = materializeDecisionSpawns({...mapped, diagnostics: {engine: "jev-bridge", bridgeVersion: 7}}, req, req.roster);
  const executed = materialized.calls?.length ? materialized : mapped;
  let spawned = null;
  if (executed.calls?.length) {
    const calls = executed.calls.map((call) => ({...call, id: call.id ?? `c${++p7CallSeq}`}));
    req.events.push({type: "decision", say: String(executed.say ?? mapped.say ?? ""), calls});
    for (const call of calls) {
      if (call.tool === "subagent") {
        const childId = `child-${++p7ChildSeq}`;
        const childSession = join(req.agent.cwd, `${childId}.jsonl`);
        writeFileSync(childSession, "");
        req.events.push({type: "tool_result", tool: "subagent", callId: call.id, output: "Spawned.", isError: false,
          details: {id: childId, sessionFile: childSession}});
        appendEntry(req.agent.sessionFile, {type: "custom", customType: "subagent-spawn",
          data: {id: childId, name: call.args?.name ?? call.spawn?.slot ?? "arm", agent: call.args?.agent, sessionFile: childSession}});
        spawned = {childId, childSession, call};
      } else if (call.tool === "escalate" || call.tool === "subagent_ask_parent") {
        req.events.push({type: "tool_result", tool: call.tool, callId: call.id, output: "Escalated.", isError: false});
      } else if (call.tool !== "subagent_done") {
        req.events.push({type: "tool_result", tool: call.tool, callId: call.id, output: "ok", isError: false});
      }
    }
  }
  return {built, mapped, materialized, executed, spawned};
}

function p7ChildDone(req, spawn, {kind = "completed", structured, schemaViolated, reportPath, reportBody = "## Evidence\nindependent evidence", purposeName = "arm"} = {}) {
  const report = reportPath ?? `${spawn.childSession}.report`;
  if (reportBody !== null) writeFileSync(report, reportBody);
  req.events.push({type: "notification", kind: "subagent_result", source: "subagent_result",
    text: `${purposeName} finished`, ts: Date.now(),
    payload: {id: spawn.childId, name: purposeName, completionKind: kind, sessionFile: spawn.childSession,
      resultStorePath: report,
      handoff: {structured, ...(schemaViolated ? {schemaViolated} : {})}}});
  appendEntry(req.agent.sessionFile, {type: "custom", customType: "subagent-complete", data: {id: spawn.childId}});
}

function p7State(fx) {
  return createConvergenceServices(fx.sessionFile).read();
}

/** Spawn one work child on the open task, complete it with a durable report, close the task. */
function p7CompleteWorkRun(fx, opts = {}) {
  const drive1 = p7Drive(fx.req, {done: {noul: 0}, next_action: {choice: "spawn_worker"}, worker_agent: {choice: "worker"}});
  assert.equal(drive1.mapped.calls[0].spawn.slot, "task:1");
  const work = drive1.spawned;
  p7ChildDone(fx.req, work, {reportPath: join(fx.dir, "work-report.md"), reportBody: "## Report\nthe widget is built"});
  fx.req.state.taskTree = {ok: true, revision: 4,
    tasks: [{id: 1, text: "Implement the widget", status: "done", ref: join(fx.dir, "evidence.md"), revision: 2, stream: 2}], legacyRootIds: []};
  if (opts.correction) appendEntry(fx.sessionFile, {type: "custom_message", role: "custom", customType: "subagent_task_update",
    details: {operationId: opts.correction.operationId, taskRevision: opts.correction.taskRevision ?? 2,
      correction: opts.correction.text, taskIds: [1]}});
  return {work, ...drive1};
}

/** Drive the full P7 pipeline: work run -> verification pass -> synthesis -> (forward). */
function p7Pipeline(fx, {verifyResult = PASS, coverage, runTo = "forward"} = {}) {
  p7CompleteWorkRun(fx);
  const verifyDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
  assert.equal(verifyDrive.mapped.calls[0].spawn.slot.startsWith("verification:"), true, "closed work routes an independent verifier");
  const verifier = verifyDrive.spawned;
  const reserved = p7State(fx);
  const ticket = reserved.tickets.at(-1);
  const binding = ticket.binding;
  p7ChildDone(fx.req, verifier, {structured: verifyResult});
  if (runTo === "verify") return {verifier, ticket, binding};
  const synthDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
  assert.equal(synthDrive.mapped.calls[0].spawn.slot.startsWith("synthesis:"), true, "a pass reserves the synthesis arm");
  const synthesizer = synthDrive.spawned;
  const synthBinding = p7State(fx).tickets.at(-1).binding;
  p7ChildDone(fx.req, synthesizer, {purposeName: "final handoff", structured: coverage ?? {
    verificationRevision: synthBinding.workRevision, taskIds: synthBinding.requiredTaskIds,
    reportIds: synthBinding.requiredReportIds, sections: SECTIONS}});
  if (runTo === "synthesize") return {verifier, synthesizer, binding: synthBinding};
  const forward = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
  return {verifier, synthesizer, binding: synthBinding, forward};
}

describe("bridge P7 convergence (v7)", () => {
  it("case 1: v6 -> v7 diagnostics; unpaired/old-extension surfaces fail with ONE pair-p7 escalation; compat gate stays v6", (t) => {
    const version = spawnSync(process.execPath, [join(import.meta.dirname, "jev-bridge.mjs"), "--version"], {encoding: "utf8"});
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "jev-bridge 7");

    // Compat: a fresh v6-style session (no P7 journal) keeps the v6 path — no P7 state leaks.
    const compat = p5Request([{type: "user_input", text: "do the thing"}]);
    const compatBuilt = buildRequest(compat);
    assert.equal(compatBuilt.state.convergence, undefined);
    assert.equal(compatBuilt.questions.p7_repair, undefined);

    // An active P7 journal under an old/missing extension surface escalates once under pair-p7.
    const fx = p7Fixture(t, {acceptance: "Build it."});
    p7Drive(fx.req); // active turn: observe writes the convergence journal
    assert.ok(Object.keys(readOrchReceipts(fx.sessionFile).receipts.operations).some((id) => id.startsWith("convergence:")));
    const strip = (capabilities, state) => {
      const req = structuredClone(fx.req);
      if (capabilities) req.capabilities = capabilities;
      if (state) for (const key of state) delete req.state[key];
      return req;
    };
    for (const [label, req] of [
      ["old extension capabilities", strip({completionKind: true}, ["convergence", "convergenceContext", "inboxDecisions"])],
      ["missing state.convergence", strip(undefined, ["convergence"])],
      ["missing convergenceContext", strip(undefined, ["convergenceContext"])],
      ["missing inboxDecisions", strip(undefined, ["inboxDecisions"])],
    ]) {
      const pairing = p7PairingProblem(req, readOrchReceipts(fx.sessionFile).receipts, {corrupt: false});
      assert.equal(pairing.mode, "pair", label);
      const escalated = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"}}, req);
      assert.equal(escalated.calls[0].tool, "escalate", label);
      assert.equal(escalated.calls[0].args.key, "pair-p7");
      assert.equal(escalated.calls[0].args.infrastructureIssue, true);
      assert.match(escalated.calls[0].args.description, /NOT completed/);
      assert.match(escalated.calls[0].args.description, /Reload both together/);
    }
    // One escalation: after acknowledgement, replay holds instead of repeating.
    const oldReq = strip({completionKind: true}, ["convergence", "convergenceContext", "inboxDecisions"]);
    const first = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"}}, oldReq);
    oldReq.events.push({type: "decision", calls: first.calls.map((call, index) => ({...call, id: `esc${index}`}))});
    oldReq.events.push({type: "tool_result", tool: "escalate", callId: "esc0", output: "Escalated.", isError: false});
    const replay = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"}}, oldReq);
    assert.deepEqual(replay.calls, []);
    assert.match(replay.say, /already sent/);
  });

  it("case 2: closed worker tasks with done confidence produce a distinct read-only verifier spawn, never done; never-pass completions fail terminally", (t) => {
    const fx = p7Fixture(t);
    p7CompleteWorkRun(fx);
    const drive = p7Drive(fx.req, {done: {noul: 0.98}, next_action: {choice: "report_done"}});
    assert.equal(drive.mapped.terminal, undefined, "classifier confidence can never authorize done");
    assert.equal(drive.mapped.calls[0].tool, "subagent");
    assert.equal(drive.mapped.calls[0].args.purpose, "verification_scout");
    assert.match(drive.mapped.calls[0].spawn.slot, /^verification:verification-\d+$/);
    // materialized: a read-only scout definition, never tasks, never the worker pointer
    assert.equal(drive.materialized.calls[0].args.agent, "independent-reader");
    assert.equal(drive.materialized.calls[0].args.tasks, undefined);
    // an in-flight/reserved verifier holds: no second arm
    const hold = p7Drive(fx.req, {done: {noul: 0.98}, next_action: {choice: "report_done"}});
    assert.deepEqual(hold.mapped.calls, []);
    assert.match(hold.mapped.say, /Holding/);
    const verifier = drive.spawned;
    // never a verification pass: flagged, incomplete, natural exit, malformed verdict, missing sidecar
    for (const extra of [{schemaViolated: true}, {kind: "exited-without-done"}, {structured: {}}, {reportBody: null}, {kind: "failed"}]) {
      const scratch = p7Fixture(t);
      p7CompleteWorkRun(scratch);
      const vdrive = p7Drive(scratch.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
      p7ChildDone(scratch.req, vdrive.spawned, {structured: PASS, ...extra});
      const after = p7Drive(scratch.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
      const state = p7State(scratch);
      assert.equal(state.verifiedRevision, undefined, `never a pass: ${JSON.stringify(extra)}`);
      assert.equal(convergenceNext(state).kind, "escalate", `terminal failure: ${JSON.stringify(extra)}`);
      assert.equal(after.mapped.calls[0]?.tool, "escalate", `escalated NOT completed: ${JSON.stringify(extra)}`);
      assert.equal(after.mapped.calls[0].args.key, "p7-failure");
      assert.match(after.mapped.calls[0].args.description, /NOT completed/);
      // replay after acknowledgement holds: no second escalation, no retry arm
      const replay = p7Drive(scratch.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
      assert.deepEqual(replay.mapped.calls, []);
    }
    assert.ok(verifier, "the first verifier spawned");
  });

  it("case 3: exact acceptance bytes, replacement/task state, revision, lineage, evidence and report refs survive materialization", (t) => {
    const acceptance = "  Exact acceptance {{literal}}\r\n🛠 widget\t ";
    const correction = " CORRECTION: keep {{unit}}\r\nlast space ";
    const fx = p7Fixture(t, {acceptance});
    p7CompleteWorkRun(fx, {correction: {operationId: "p4-scope-42", text: correction}});
    const drive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const state = p7State(fx);
    const ticket = state.tickets.at(-1);
    assert.equal(ticket.binding.acceptanceCriteria, `${acceptance}\n\n${correction}`);
    assert.equal(ticket.kind, "verification");
    assert.equal(ticket.binding.tasks[0].ref, join(fx.dir, "evidence.md"));
    assert.equal(ticket.binding.tasks[0].status, "done");
    const slots = convergenceSpawnSlots(state, ticket.id, {cwd: fx.dir, artifactRoot: fx.dir, lineage: ["root", "orch-1"], stream: 2});
    assert.equal(slots.taskText, ticket.binding.acceptanceCriteria);
    const materialized = drive.materialized.calls[0].args;
    assert.ok(String(materialized.task).includes(acceptance));
    assert.ok(String(materialized.task).includes(correction));
    assert.ok(String(materialized.task).includes(join(fx.dir, "work-report.md")), "durable report refs ride the brief");
    assert.ok(!String(materialized.task).includes("ENGINE PROSE"));
    assert.equal(materialized.tasks, undefined, "no implementation task assignment to the verifier");
    assert.equal(materialized.purpose, "verification_scout");
    assert.equal(materialized.spawnSlot, `verification:${ticket.id}`);
    assert.ok(String(materialized.task).includes('"lineage":["root","orch-1"]'), "mechanical lineage rides the brief");
    assert.equal(ticket.binding.workRevision, state.workRevision);
    assert.ok(ticket.binding.requiredReportIds.includes("report:child-1"));
  });

  it("case 4: a current-revision pass reserves synthesis (worker:), never engine done; missing scout/worker escalates without retries-as-pass", (t) => {
    const fx = p7Fixture(t);
    p7CompleteWorkRun(fx);
    const verifyDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    p7ChildDone(fx.req, verifyDrive.spawned, {structured: PASS});
    const synthDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(synthDrive.mapped.terminal, undefined, "a pass is never engine done");
    assert.match(synthDrive.mapped.calls[0].spawn.slot, /^synthesis:synthesis-\d+$/);
    assert.equal(synthDrive.mapped.calls[0].args.purpose, "synthesis");
    assert.equal(synthDrive.materialized.calls[0].args.agent, "worker", "worker: applies to synthesis");
    assert.ok((synthDrive.materialized.calls[0].args.resultSchema ?? {}).properties?.verificationRevision);

    // Missing eligible scout: the extension's admission failure escalates with the exact slot;
    // the folded launch(isError) ends the run — no retry-as-pass, no second escalation.
    const noScout = p7Fixture(t, {roster: [{name: "writer"}, {name: "worker"}]});
    p7CompleteWorkRun(noScout);
    const drive = p7Drive(noScout.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(drive.materialized.calls[0].tool, "escalate");
    assert.match(drive.materialized.calls[0].args.key, /^p7-verification-verification-\d+$/);
    assert.match(drive.materialized.calls[0].args.description, /spawn_slot: verification:verification-\d+/);
    const after = p7Drive(noScout.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(p7State(noScout).failure, "Independent arm spawn failed/ambiguous; NOT completed");
    assert.equal(convergenceNext(p7State(noScout)).kind, "escalate");
    assert.deepEqual(after.mapped.calls, [], "the recorded admission failure key is reused; no second escalation");
  });

  it("case 5: findings route a finite repair decision; repair work mutates and re-verifies; three changes_required escalate with no fourth spawn", (t) => {
    const findings = ["Exact broken test", "second finding"];
    const changes = {verdict: "changes_required", evidence: ["tests.log"], findings};
    const fx = p7Fixture(t);
    p7CompleteWorkRun(fx);
    const verifyDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const verifier = verifyDrive.spawned;
    const reportRef = `${verifier.childSession}.report`;
    p7ChildDone(fx.req, verifier, {structured: changes});
    const built = buildRequest(fx.req);
    assert.equal(built.questions.p7_repair.type, "choice");
    assert.equal(Object.keys(built.questions.p7_repair.criteria).includes("escalate"), true);
    assert.equal(built.questions.p7_repair.criteria.dispatch_thinker, undefined, "no admitted thinker slot -> not offered");
    assert.ok(built.questions.p7_repair.instructions.includes(reportRef));
    assert.ok(built.questions.p7_repair.instructions.includes("Exact broken test"));
    assert.ok(built.questions.p7_repair.instructions.includes("second finding"));
    const vTicketId = verifyDrive.mapped.calls[0].spawn.slot.slice("verification:".length);
    const escalated = p7Drive(fx.req, {p7_repair: {choice: "escalate"}, done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(escalated.mapped.calls[0].tool, "escalate");
    assert.equal(escalated.mapped.calls[0].args.key, `p7-repair:${vTicketId}:escalate`);
    assert.match(escalated.mapped.calls[0].args.description, /Exact broken test/);
    assert.match(escalated.mapped.calls[0].args.description, /NOT completed/);

    // Real repair work (an admitted task update) mutates and forces a new-revision verifier.
    appendEntry(fx.sessionFile, {type: "custom_message", role: "custom", customType: "subagent_task_update",
      details: {operationId: "p4-repair-7", taskRevision: 3, correction: "Fix the broken test.", taskIds: [1]}});
    const revisionBefore = p7State(fx).workRevision;
    const reverify = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const afterRepair = p7State(fx);
    assert.ok(afterRepair.workRevision > revisionBefore, "repair task update mutates the revision");
    assert.equal(afterRepair.verifiedRevision, undefined);
    assert.match(reverify.mapped.calls[0].spawn.slot, /^verification:verification-\d+$/);
    assert.notEqual(reverify.mapped.calls[0].spawn.slot, `verification:${vTicketId}`, "new-revision verifier");

    // Cap: three completed changes_required rounds escalate with no fourth spawn.
    const cap = p7Fixture(t);
    p7CompleteWorkRun(cap);
    let ticketSeq = 1;
    for (let round = 1; round <= 3; round++) {
      if (round > 1) appendEntry(cap.sessionFile, {type: "custom_message", role: "custom", customType: "subagent_task_update",
        details: {operationId: `p4-repair-${round}`, taskRevision: 2 + round, correction: `Repair round ${round}.`, taskIds: [1]}});
      const drive = p7Drive(cap.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
      assert.equal(drive.mapped.calls[0]?.tool, "subagent", `round ${round} spawns a verifier`);
      ticketSeq += 1;
      p7ChildDone(cap.req, drive.spawned, {structured: changes});
    }
    const capped = p7Drive(cap.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(cap.req.events.filter((e) => e.type === "decision").flatMap((e) => e.calls ?? []).filter((c) => c.tool === "subagent" && String(c.spawn?.slot ?? "").startsWith("verification:")).length, 3);
    assert.equal(convergenceNext(p7State(cap)).kind, "escalate");
    assert.match(p7State(cap).failure, /cap exhausted.*NOT completed/);
    assert.equal(capped.mapped.calls[0].tool, "escalate");
    assert.equal(capped.mapped.calls[0].args.key, "p7-failure");
  });

  it("case 6: scope/evidence/resume changes invalidate a pass, including while verification is live; same-path evidence changes are detected by digest", (t) => {
    const fx = p7Fixture(t);
    p7CompleteWorkRun(fx);
    const verifyDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const verifier = verifyDrive.spawned;
    // Same-path evidence change while the verifier runs: digest detection, late pass is stale.
    writeFileSync(join(fx.dir, "evidence.md"), "widget evidence — CHANGED\n");
    p7ChildDone(fx.req, verifier, {structured: PASS});
    buildRequest(fx.req); // fold the late completion before reading durable state
    const afterLatePass = p7State(fx);
    assert.equal(afterLatePass.verifiedRevision, undefined, "a late old-revision pass grants no pass");
    assert.equal(convergenceNext(afterLatePass).kind, "verify");
    // A new-revision verifier passes on the new digest.
    const reverify = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    p7ChildDone(fx.req, reverify.spawned, {structured: PASS});
    buildRequest(fx.req); // fold the new verifier completion before reading state
    const passed = p7State(fx);
    assert.equal(passed.verifiedRevision, passed.workRevision);

    // A scope correction invalidates the standing pass immediately.
    appendEntry(fx.sessionFile, {type: "custom_message", role: "custom", customType: "subagent_task_update",
      details: {operationId: "p4-scope-9", taskRevision: 5, correction: "Also handle the edge case.", taskIds: [1]}});
    const scopedDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const scoped = p7State(fx);
    assert.ok(scoped.workRevision > passed.workRevision);
    assert.equal(scoped.verifiedRevision, undefined, "old pass is stale after scope change");
    assert.match(scopedDrive.mapped.calls[0].spawn.slot, /^verification:verification-\d+$/, "scope change forces a new-revision verifier");
    // Task state changes (open task) also invalidate: taskClosureProblems rejects an open run.
    const open = structuredClone(fx.req);
    open.state.taskTree = {ok: true, revision: 6, tasks: [{id: 1, text: "Implement the widget", status: "in_progress", revision: 3, assignedToId: "orch-1", stream: 2}], legacyRootIds: []};
    const held = mapAnswers({done: {noul: 0.95}, next_action: {choice: "report_done"}}, open);
    assert.deepEqual(held.calls, []);
    assert.match(held.say, /readiness is not clean|Holding/);
    assert.ok(taskClosureProblems(open.state.taskTree.tasks).length > 0);
  });

  it("case 7: status/think/verification artifacts do not change workRevision; synthesis reports never recurse", (t) => {
    const fx = p7Fixture(t);
    const {verifier} = p7Pipeline(fx, {runTo: "verify"});
    buildRequest(fx.req); // fold the pass before reading durable state
    const revisionAtPass = p7State(fx).workRevision;
    assert.equal(p7State(fx).verifiedRevision, revisionAtPass);
    // A late verification report entering the manifest does not bump the revision or the pass.
    assert.equal(p7State(fx).workRevision, revisionAtPass);
    assert.equal(convergenceNext(p7State(fx)).kind, "synthesize", "no scout-of-scout after a pass");
    const synthDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const synthesizer = synthDrive.spawned;
    const binding = p7State(fx).tickets.at(-1).binding;
    p7ChildDone(fx.req, synthesizer, {purposeName: "final handoff", structured: {
      verificationRevision: binding.workRevision, taskIds: binding.requiredTaskIds,
      reportIds: binding.requiredReportIds, sections: SECTIONS}});
    // The synthesis artifact itself does not recurse or invalidate coverage.
    p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const state = p7State(fx);
    assert.equal(convergenceGate(state, p7Readiness(fx.req, state, {corrupt: false, writeError: null})).completed, true);
    assert.equal(convergenceNext(state).kind, "forward");
    assert.ok(verifier);
  });

  it("case 8: zero-worker done requires a goal-status scout; a previously spawned worker forbids the shortcut; confidence 1.0 never terminates alone", (t) => {
    const zero = p7Fixture(t, {tree: {ok: true, revision: 1, tasks: [], legacyRootIds: []}});
    const drive = p7Drive(zero.req, {done: {noul: 1.0}, next_action: {choice: "report_done"}});
    assert.equal(drive.mapped.terminal, undefined, "confidence 1.0 without independent evidence never terminates");
    assert.match(drive.mapped.calls[0].spawn.slot, /^goal_status:goal_status-\d+$/);
    assert.equal(drive.mapped.calls[0].args.purpose, "verification_scout");
    assert.equal(drive.materialized.calls[0].args.agent, "independent-reader", "read-only scout, never a verify+repair worker");
    p7ChildDone(zero.req, drive.spawned, {structured: PASS});
    const synth = p7Drive(zero.req, {done: {noul: 1.0}, next_action: {choice: "report_done"}});
    assert.equal(synth.mapped.calls[0].spawn.slot.startsWith("synthesis:"), true);

    // A previously spawned failed/no-report worker cannot take the zero-worker shortcut.
    const spawnedOnce = p7Fixture(t);
    const work = p7Drive(spawnedOnce.req, {done: {noul: 0.1}, next_action: {choice: "spawn_worker"}, worker_agent: {choice: "worker"}});
    assert.equal(work.mapped.calls[0].spawn.slot, "task:1");
    assert.equal(work.mapped.terminal, undefined);
    p7ChildDone(spawnedOnce.req, work.spawned, {kind: "failed", reportBody: null});
    spawnedOnce.req.state.taskTree = {ok: true, revision: 4,
      tasks: [{id: 1, text: "Implement the widget", status: "done", ref: join(spawnedOnce.dir, "evidence.md"), revision: 2, stream: 2}], legacyRootIds: []};
    const verify = p7Drive(spawnedOnce.req, {done: {noul: 1.0}, next_action: {choice: "report_done"}});
    assert.equal(verify.mapped.terminal, undefined, "confidence 1.0 never terminates without independent evidence");
    assert.equal(verify.mapped.calls[0].spawn.slot.startsWith("verification:"), true, "spawned work requires verification, not goal_status");
  });

  it("case 9: coverage misses route one correction; a second miss or a failed launch escalates; new report obligations during synthesis require correction", (t) => {
    const fx = p7Fixture(t);
    p7CompleteWorkRun(fx);
    const verifyDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    p7ChildDone(fx.req, verifyDrive.spawned, {structured: PASS});
    const synthDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const synthesizer = synthDrive.spawned;
    const binding = p7State(fx).tickets.at(-1).binding;
    p7ChildDone(fx.req, synthesizer, {purposeName: "final handoff", structured: {
      verificationRevision: binding.workRevision, taskIds: [], reportIds: binding.requiredReportIds, sections: SECTIONS}});
    const built = buildRequest(fx.req);
    assert.equal(built.questions.p7_synthesis_correction.type, "choice");
    assert.deepEqual(Object.keys(built.questions.p7_synthesis_correction.criteria).sort(), ["corrected_synthesis", "escalate"]);
    assert.ok(built.questions.p7_synthesis_correction.instructions.includes("Missing task #1"));
    const sTicketId = synthDrive.mapped.calls[0].spawn.slot.slice("synthesis:".length);
    const corrected = p7Drive(fx.req, {p7_synthesis_correction: {choice: "corrected_synthesis"}, done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.match(corrected.mapped.calls[0].spawn.slot, /^synthesis:synthesis-\d+$/);
    assert.notEqual(corrected.mapped.calls[0].spawn.slot, `synthesis:${sTicketId}`);
    const binding2 = p7State(fx).tickets.at(-1).binding;
    p7ChildDone(fx.req, corrected.spawned, {purposeName: "final handoff", structured: {
      verificationRevision: binding2.workRevision, taskIds: binding2.requiredTaskIds,
      reportIds: binding2.requiredReportIds, sections: SECTIONS}});
    const forwarded = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(forwarded.mapped.terminal, true);

    // A second incomplete synthesis escalates (cap), never a third spawn.
    const second = p7Fixture(t);
    p7CompleteWorkRun(second);
    const vd = p7Drive(second.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    p7ChildDone(second.req, vd.spawned, {structured: PASS});
    const s1 = p7Drive(second.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const b1 = p7State(second).tickets.at(-1).binding;
    p7ChildDone(second.req, s1.spawned, {purposeName: "final handoff", structured: {
      verificationRevision: b1.workRevision, taskIds: [], reportIds: b1.requiredReportIds, sections: SECTIONS}});
    const c2 = p7Drive(second.req, {p7_synthesis_correction: {choice: "corrected_synthesis"}, done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const b2 = p7State(second).tickets.at(-1).binding;
    p7ChildDone(second.req, c2.spawned, {purposeName: "final handoff", structured: {
      verificationRevision: b2.workRevision, taskIds: [], reportIds: b2.requiredReportIds, sections: SECTIONS}});
    buildRequest(second.req); // fold the second miss before reading state
    assert.equal(convergenceNext(p7State(second)).kind, "escalate");
    const capped = p7Drive(second.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(capped.mapped.calls[0].tool, "escalate");
    assert.equal(capped.mapped.calls[0].args.key, "p7-failure");

    // A failed first synthesis launch is terminal: no coverage, no correction retry.
    const failed = p7Fixture(t);
    p7CompleteWorkRun(failed);
    const fvd = p7Drive(failed.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    p7ChildDone(failed.req, fvd.spawned, {structured: PASS});
    const fsd = p7Drive(failed.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const refusedCallId = `c${p7CallSeq}`;
    failed.req.events = failed.req.events.filter((e) => !(e.type === "tool_result" && e.tool === "subagent" && e.callId === refusedCallId));
    failed.req.events.push({type: "tool_result", tool: "subagent", callId: refusedCallId, output: "spawn refused", isError: true});
    const after = p7Drive(failed.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.match(p7State(failed).failure, /spawn failed|NOT completed/);
    assert.equal(convergenceNext(p7State(failed)).kind, "escalate");
    assert.equal(after.mapped.calls[0]?.tool, "escalate");

    // New non-work report obligations during synthesis require correction, not a new verification.
    const late = p7Fixture(t);
    p7CompleteWorkRun(late);
    const lvd = p7Drive(late.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    p7ChildDone(late.req, lvd.spawned, {structured: PASS});
    const lsd = p7Drive(late.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const lbinding = p7State(late).tickets.at(-1).binding;
    // A pending ask routes the thinker (E1) while the synthesis arm runs; its durable
    // report becomes a new coverage obligation the reserved synthesis did not bind.
    late.req.spawnContexts.push({id: "think:ask-1", purpose: "think", name: "Question: ask-1", askId: "ask-1",
      taskText: "Should we ship?", cwd: late.dir, artifactRoot: late.dir, lineage: ["root"]});
    late.req.events.push({type: "notification", kind: "ask", source: "subagent_question", text: "q",
      payload: {askId: "ask-1", id: "child-ask", name: "Widget implementation", question: "Should we ship?"}});
    const thinker = p7Drive(late.req, {done: {noul: 0}, next_action: {choice: "wait"}});
    assert.equal(thinker.mapped.calls[0].spawn.slot, "think:ask-1");
    p7ChildDone(late.req, thinker.spawned, {purposeName: "thinker", reportBody: "## Think\nan answer"});
    late.req.events.push({type: "notification", kind: "answer", source: "subagent_child_answer",
      text: "a", payload: {askId: "ask-1"}});
    p7ChildDone(late.req, lsd.spawned, {purposeName: "final handoff", structured: {
      verificationRevision: lbinding.workRevision, taskIds: lbinding.requiredTaskIds,
      reportIds: lbinding.requiredReportIds, sections: SECTIONS}});
    buildRequest(late.req); // fold the synthesis completion before reading state
    const built2 = buildRequest(late.req);
    assert.equal(built2.questions.p7_synthesis_correction !== undefined || convergenceNext(p7State(late)).kind === "synthesis_correction_decision", true);
    assert.equal(p7State(late).verifiedRevision, p7State(late).workRevision, "report obligations do not invalidate the pass");
  });

  it("case 10: asks, notifications, approvals, live children, open/replaced tasks and missing stores block reservation and done; ack alone never releases an approval", (t) => {
    const blockers = (fx) => {
      const drive = p7Drive(fx.req, {done: {noul: 0.98}, next_action: {choice: "report_done"}});
      return drive;
    };
    // pending ask: routes the thinker (E1), never a verifier.
    const ask = p7Fixture(t);
    ask.req.spawnContexts.push({id: "think:ask-9", purpose: "think", name: "Question: ask-9", askId: "ask-9",
      taskText: "Should we ship?", cwd: ask.dir, artifactRoot: ask.dir, lineage: ["root"]});
    p7CompleteWorkRun(ask);
    ask.req.events.push({type: "notification", kind: "ask", source: "subagent_question",
      text: "ask", payload: {askId: "ask-9", id: "child-1", name: "Widget implementation", question: "Should we ship?"}});
    const askDrive = blockers(ask);
    assert.equal(askDrive.mapped.calls[0].spawn.slot, "think:ask-9", "pending asks route the thinker, never a verifier");
    // pending outbox delivery obligation blocks.
    const outbox = p7Fixture(t);
    p7CompleteWorkRun(outbox);
    outbox.req.state.taskUpdateOutbox = {ok: true, pending: [{key: "delivery-42", ownerId: "orch-1", status: "pending"}]};
    assert.deepEqual(blockers(outbox).mapped.calls, []);
    // unresolved user approval blocks; an ack/dismissal alone never releases it.
    const approval = p7Fixture(t);
    p7CompleteWorkRun(approval);
    appendEntry(approval.sessionFile, {type: "custom", customType: "inbox-item",
      data: {id: "infra-key-1", kind: "infra-issue", title: "Approve the widget", ts: 1,
        decide: {question: "Approve?", options: ["Yes"]}}});
    assert.deepEqual(blockers(approval).mapped.calls, []);
    appendEntry(approval.sessionFile, {type: "custom", customType: "inbox-acked", data: {id: "infra-key-1", ts: 2}});
    assert.deepEqual(blockers(approval).mapped.calls, [], "an ack/dismissal is not approval");
    // live children block.
    const live = p7Fixture(t);
    p7CompleteWorkRun(live);
    const extra = p7Drive(live.req, {done: {noul: 0.5}, next_action: {choice: "spawn_worker"}, worker_agent: {choice: "worker"}});
    const again = blockers(live);
    assert.deepEqual(again.mapped.calls, [], `live child ${extra.spawned.childId} holds`);
    // own-run in-progress root and pending replacement block closure.
    const ownRun = p7Fixture(t, {tree: {ok: true, revision: 3,
      tasks: [{id: 1, text: "Implement the widget", status: "in_progress", assignedToId: "orch-1", revision: 1, stream: 2}], legacyRootIds: []}});
    assert.deepEqual(blockers(ownRun).mapped.calls, []);
    const replaced = p7Fixture(t, {tree: {ok: true, revision: 3,
      tasks: [{id: 1, text: "Implement the widget", status: "replaced", supersededBy: 9, revision: 1, stream: 2}], legacyRootIds: []}});
    assert.deepEqual(blockers(replaced).mapped.calls, []);
    // a missing/unreadable store is an infra escalation, never empty success.
    const store = p7Fixture(t, {tree: {ok: false, error: "Task store unavailable"}});
    const storeDrive = blockers(store);
    assert.equal(storeDrive.mapped.calls[0].tool, "escalate");
    assert.equal(storeDrive.mapped.calls[0].args.infrastructureIssue, true);
    assert.match(storeDrive.mapped.calls[0].args.description, /Task store unavailable/);
  });

  it("case 11: a 100k-character synthesis report forwards byte-for-byte with attribution; preflight failures escalate NOT completed", (t) => {
    const fx = p7Fixture(t);
    const {synthesizer} = p7Pipeline(fx);
    const reportPath = `${synthesizer.childSession}.report`;
    const long = "## Evidence\n" + "Not truncated or concatenated. ".repeat(4000) + "\nIMPORTANT TAIL";
    assert.ok(long.length > 100000);
    writeFileSync(reportPath, long);
    const drive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    assert.equal(drive.mapped.terminal, true);
    assert.equal(drive.mapped.calls[0].tool, "subagent_done");
    const args = drive.mapped.calls[0].args;
    assert.equal(args.forward, synthesizer.childId);
    assert.equal(args.result, `Synthesis report: ${reportPath}`);
    assert.ok(!args.result.includes("IMPORTANT TAIL"), "engine result carries only the pointer, never conclusions");
    assert.equal(buildForwardBody("from Synthesis", readFileSync(reportPath, "utf8")), `[forwarded — from Synthesis]\n\n${long}`);
    assert.equal(readFileSync(reportPath, "utf8"), long, "the durable sidecar is the exact byte source");

    // Preflight: missing subagent-complete entry, unreadable/empty sidecar — escalate, never forward.
    for (const mangle of ["no-complete-entry", "empty-sidecar", "missing-sidecar"]) {
      const scratchFx = p7Fixture(t);
      const {synthesizer: synth} = p7Pipeline(scratchFx);
      const path = `${synth.childSession}.report`;
      const longBody = "## Evidence\n" + "tail survives ".repeat(2000) + "\nIMPORTANT TAIL";
      writeFileSync(path, longBody);
      if (mangle === "no-complete-entry") {
        const kept = readFileSync(scratchFx.sessionFile, "utf8").split("\n").filter(Boolean)
          .filter((line) => !line.includes('"subagent-complete"'));
        writeFileSync(scratchFx.sessionFile, `${kept.join("\n")}\n`);
      } else if (mangle === "empty-sidecar") {
        writeFileSync(path, "");
      } else {
        rmSync(path);
      }
      const refused = mapAnswers({done: {noul: 0.95}, next_action: {choice: "report_done"}}, scratchFx.req);
      assert.equal(refused.terminal, undefined, mangle);
      assert.equal(refused.calls[0].tool, "escalate", mangle);
      assert.equal(refused.calls[0].args.key, "p7-forward");
      assert.match(refused.calls[0].args.description, /NOT completed/);
    }
  });

  it("case 12: duplicate stable events are no-ops; a missing ack never launches twice; stale bridge saves preserve P7 claims; corrupt chains fail closed", (t) => {
    const fx = p7Fixture(t);
    const {verifier} = p7Pipeline(fx, {runTo: "verify"});
    // Duplicate completion events are no-ops: state sequence is stable across replays.
    p7ChildDone(fx.req, verifier, {structured: PASS});
    const first = mapAnswers({done: {noul: 0.95}, next_action: {choice: "report_done"}}, fx.req);
    assert.match(first.calls[0].spawn.slot, /^synthesis:/);
    // Record the spawn intent but not its acknowledgement: a reserved arm with a
    // call and no ack HOLDS — no second reserve, no launch, no crash escalation.
    fx.req.events.push({type: "decision", say: String(first.say ?? ""),
      calls: first.calls.map((call) => ({...call, id: `c${++p7CallSeq}`}))});
    const sequence = p7State(fx).sequence;
    const again = mapAnswers({done: {noul: 0.95}, next_action: {choice: "report_done"}}, fx.req);
    assert.equal(p7State(fx).sequence, sequence, "duplicate folds do not advance the chain");
    assert.deepEqual(again.calls, []);
    assert.equal(p7State(fx).tickets.at(-1).status, "reserved");

    // A reserved verifier with a spawn call but no acknowledgement holds; never another launch.
    const holdFx = p7Fixture(t);
    p7CompleteWorkRun(holdFx);
    const reserveDrive = p7Drive(holdFx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const pendingEvents = holdFx.req.events.filter((e) => !(e.type === "tool_result" && e.tool === "subagent" && e.callId === `c${p7CallSeq}`));
    const pendingReq = {...holdFx.req, events: pendingEvents};
    const held = mapAnswers({done: {noul: 0.95}, next_action: {choice: "report_done"}}, pendingReq);
    assert.deepEqual(held.calls, []);
    assert.match(held.say, /Holding/);
    assert.equal(p7State(holdFx).tickets.at(-1).status, "reserved", "no launch without the acknowledgement");

    // A stale bridge save preserves shared P7 claims (verifiedRevision survives the merge).
    const staleReceipts = readOrchReceipts(fx.sessionFile).receipts;
    const staleSnapshot = structuredClone(staleReceipts);
    assert.equal(saveOrchReceipts(fx.sessionFile, staleSnapshot).ok, true);
    const survived = p7State(fx);
    assert.equal(survived.verifiedRevision, survived.workRevision, "the pass survives a stale bridge save");

    // Corrupt receipt chain: fail closed with an infrastructure escalation, never empty success.
    const loaded = JSON.parse(readFileSync(`${fx.sessionFile}.orch.json`, "utf8"));
    const record = Object.values(loaded.operations).find((operation) => operation?.effect?.detail?.state?.tickets);
    record.effect.detail.state.workRevision = 999;
    writeFileSync(`${fx.sessionFile}.orch.json`, JSON.stringify(loaded));
    rmSync(`${fx.sessionFile}.orch`);
    const refused = mapAnswers({done: {noul: 0.95}, next_action: {choice: "report_done"}}, fx.req);
    assert.equal(refused.calls[0].tool, "escalate");
    assert.equal(refused.calls[0].args.infrastructureIssue, true);
    assert.match(String(refused.calls[0].args.description), /NOT completed/);
  });

  it("case 14: resume reservations release pendingRecovery only on a reconciled launch outcome; consumed alone blocks", (t) => {
    const fx = p7Fixture(t);
    p7CompleteWorkRun(fx);
    buildRequest(fx.req); // fold the work spawn into the durable ledger
    const readiness = () => p7Readiness(fx.req, p7State(fx), {corrupt: false, writeError: null});
    const plant = (mutate) => {
      const receipts = readOrchReceipts(fx.sessionFile).receipts;
      mutate(receipts);
      assert.equal(saveOrchReceipts(fx.sessionFile, structuredClone(receipts)).ok, true);
    };
    const workRowKey = Object.keys(readOrchReceipts(fx.sessionFile).receipts.lifecycle)
      .find((key) => readOrchReceipts(fx.sessionFile).receipts.lifecycle[key].purpose === "work");
    assert.ok(workRowKey, "the fixture has a work lifecycle row");
    // A consumed-but-unlaunched reservation blocks readiness forever without this reconciliation.
    plant((receipts) => {
      receipts.resumeReservations["recovery-effect:9:resume"] =
        {childId: workRowKey, sessionFile: fx.sessionFile, attempt: 2, reservedAt: 1, consumed: true};
    });
    assert.equal(readiness().pendingRecovery, 1, "a consumed reservation alone is not launch success");
    // Reconciled launch outcome 1: the reservation's own operation carries an acknowledged committed effect.
    plant((receipts) => {
      receipts.operations["recovery-effect:9:resume"] = {
        intent: {phase: "intent"}, acknowledgement: {phase: "acknowledgement"}, effect: {phase: "effect"},
      };
    });
    assert.equal(readiness().pendingRecovery, 0, "an acknowledged committed effect is a reconciled launch outcome");
    assert.ok(readOrchReceipts(fx.sessionFile).receipts.resumeReservations["recovery-effect:9:resume"],
      "the reservation persists; only its outcome reconciles");
    // Reconciled launch outcome 2: the resumed child's lifecycle row (failure outcome) without an effect.
    plant((receipts) => {
      delete receipts.operations["recovery-effect:9:resume"];
      receipts.lifecycle[workRowKey].resumedBy = "child-9";
      receipts.lifecycle["child-9"] = {childId: "child-9", state: "failed", stateTs: 2, attempt: 2,
        resumedFrom: workRowKey, purpose: "work", sessionFile: fx.sessionFile};
    });
    assert.equal(readiness().pendingRecovery, 0, "the resumed child's lifecycle row closes the reservation, success or failure");
    // A second outstanding reservation still blocks (dedupe by reservation id).
    plant((receipts) => {
      receipts.resumeReservations["recovery-effect:10:resume"] =
        {childId: workRowKey, sessionFile: fx.sessionFile, attempt: 3, reservedAt: 2, consumed: true};
    });
    assert.equal(readiness().pendingRecovery, 1, "another unlaunched reservation still blocks");
  });

  it("case 15: a replayed dispatch_thinker repair selection holds on the recorded dispatch id, never re-thinks", (t) => {
    const fx = p7Fixture(t);
    fx.req.spawnContexts.push({id: "think:t-1", purpose: "think", name: "Question: repair",
      taskText: "Obtain repair edits", cwd: fx.dir, artifactRoot: fx.dir, lineage: ["root", "orch-1"]});
    p7CompleteWorkRun(fx);
    const verifyDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
    const verifier = verifyDrive.spawned;
    p7ChildDone(fx.req, verifier, {structured: {verdict: "changes_required", evidence: ["tests.log"], findings: ["Broken test"]}});
    const answers = {p7_repair: {choice: "dispatch_thinker"}, done: {noul: 0.95}, next_action: {choice: "report_done"}};
    const first = p7Drive(fx.req, answers);
    assert.equal(first.mapped.calls[0].tool, "subagent");
    assert.equal(first.mapped.calls[0].args.agent, "thinker");
    assert.equal(first.mapped.calls[0].spawn.slot, "think:t-1");
    const replay = p7Drive(fx.req, answers);
    assert.deepEqual(replay.mapped.calls, [], "replay cannot re-think: the recorded dispatch id holds");
    assert.match(replay.mapped.say, /already recorded|cannot re-think/);
  });

  it("case 16: free-text/unoffered decisions cannot release the approval gate; an admitted finite-option decision can", (t) => {
    const fx = p7Fixture(t);
    p7CompleteWorkRun(fx);
    const blockers = () => p7Drive(fx.req, {done: {noul: 0.98}, next_action: {choice: "report_done"}});
    const item = (decision) => ({type: "custom", customType: "inbox-item",
      data: {id: "infra-key-2", kind: "infra-issue", title: "Approve the widget", ts: 1,
        decide: {question: "Approve?", options: ["ship", "hold"]}, ...(decision ? {decision} : {})}});
    // A free-text "Other" decision does not release the gate.
    appendEntry(fx.sessionFile, item({choice: "ship it my way", other: true, ts: 2}));
    assert.deepEqual(blockers().mapped.calls, [], "a free-text decision cannot release the approval gate");
    // An unoffered choice recorded as a real option does not release it either.
    appendEntry(fx.sessionFile, item({choice: "maybe", other: false, ts: 3}));
    assert.deepEqual(blockers().mapped.calls, [], "an unoffered choice cannot release the approval gate");
    // An admitted finite-option decision, durably recorded, releases it.
    appendEntry(fx.sessionFile, item({choice: "ship", other: false, ts: 4}));
    const released = blockers();
    assert.equal(released.mapped.calls[0]?.tool, "subagent", "an admitted finite-option decision releases the gate");
  });

  it("case 17: the repair apply-branch re-matches the persisted offer's reportRef against the verifier ticket", (t) => {
    const changes = {verdict: "changes_required", evidence: ["tests.log"], findings: ["Broken test"]};
    const prepare = () => {
      const fx = p7Fixture(t);
      p7CompleteWorkRun(fx);
      const verifyDrive = p7Drive(fx.req, {done: {noul: 0.95}, next_action: {choice: "report_done"}});
      const verifier = verifyDrive.spawned;
      p7ChildDone(fx.req, verifier, {structured: changes});
      return {fx, reportRef: `${verifier.childSession}.report`};
    };
    const plantOffer = (fx, reportRef) => {
      const receipts = readOrchReceipts(fx.sessionFile).receipts;
      receipts.operations["completion-offer:co-77"] = {intent: {phase: "intent"},
        effect: {phase: "effect", detail: {offer: {completionId: "co-77", snapshotRevision: 0, offerHash: "hash-77",
          reportRef, decisions: [{id: "opt-1"}]}}}};
      assert.equal(saveOrchReceipts(fx.sessionFile, structuredClone(receipts)).ok, true);
    };
    const answers = {p7_repair: {choice: "apply:opt-1"}, done: {noul: 0.95}, next_action: {choice: "report_done"}};
    // An option carried by an unrelated pending offer escalates; never apply_decision against the wrong completion.
    const wrong = prepare();
    plantOffer(wrong.fx, "/tmp/unrelated.report");
    const wrongDrive = p7Drive(wrong.fx.req, answers);
    assert.equal(wrongDrive.mapped.calls[0].tool, "escalate");
    assert.equal(wrongDrive.mapped.calls[0].args.infrastructureIssue, true);
    assert.match(wrongDrive.mapped.calls[0].args.description, /No admitted completion offer carries option/i);
    // The offer whose reportRef matches the verifier ticket executes through apply_decision.
    const right = prepare();
    plantOffer(right.fx, right.reportRef);
    const built = buildRequest(right.fx.req);
    assert.ok(built.questions.p7_repair.criteria["apply:opt-1"], "only the matching offer's option is presented");
    const rightDrive = p7Drive(right.fx.req, answers);
    assert.equal(rightDrive.mapped.calls[0].tool, "apply_decision");
    assert.equal(rightDrive.mapped.calls[0].args.completionId, "co-77");
    assert.equal(rightDrive.mapped.calls[0].args.optionId, "opt-1");
    assert.equal(rightDrive.mapped.calls[0].args.reportRef, right.reportRef);
  });

  it("case 13: P0a–P6 fixtures stay green under the v7 bridge (compat path) and no P7 surface leaks into v6 sessions", () => {
    // The v6 describes above (resume fold + P5 reconciliation, 21 cases) are the P0a–P6
    // fixtures; this case pins the compat boundary they depend on.
    const v6 = p5Request([{type: "user_input", text: "v6 goal"}]);
    const built = buildRequest(v6);
    assert.equal(built.state.convergence, undefined);
    assert.equal(built.state.p7_pairing_error, undefined);
    assert.equal(built.questions.p7_repair, undefined);
    assert.equal(built.questions.p7_synthesis_correction, undefined);
    const tree = {ok: true, revision: 4, tasks: [{...P5_TASK, status: "done", ref: "/tmp/evidence.md"}], legacyRootIds: []};
    const converged = mapAnswers({done: {noul: 0.9}, next_action: {choice: "report_done"}}, p5Request(
      [{type: "user_input", text: "v6 goal"}, {type: "notification", kind: "subagent_result", source: "subagent_result",
        text: "done", payload: {id: "child-1", name: "Worker 1", completionKind: "completed", resultStorePath: "/tmp/r.md"}}],
      {tree}));
    assert.equal(converged.terminal, true, "an unpaired v6 session still converges through the v6 path");
  });
});
