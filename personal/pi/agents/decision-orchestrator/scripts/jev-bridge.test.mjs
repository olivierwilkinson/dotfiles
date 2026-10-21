// Bridge-local fold regressions. Run with JEV_SUBAGENTS_PATH pointing at the
// candidate extension's pi-extension/subagents directory, never the installed copy:
// JEV_SUBAGENTS_PATH=/path/to/extension/pi-extension/subagents node --test jev-bridge.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
