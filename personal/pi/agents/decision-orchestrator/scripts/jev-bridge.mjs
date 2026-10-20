#!/usr/bin/env node
// jev-bridge: stdio decision engine for the `decision` provider.
//
// Reads one pi-decision-v1 DecisionRequest JSON line on stdin, asks the jev
// engine (TypeSafe System One via Shopify AI Proxy, using the shop-pi-fy jev
// extension's request/auth code) a question battery, maps the answers to
// concrete tool calls, and writes one DecisionResult JSON line to stdout.
//
// Mechanical orchestration only, like any orchestrator: it may spawn several
// workers (agents chosen from the request's roster), wait, check in on any
// running worker, and converge every worker's report into one subagent_done.
//
// Exit codes: 0 with a result line on success; non-zero on any fault (the
// provider's fault/repair loop handles retries).
//
// Staleness: a stdio engine process is long-lived per session and pins this
// bridge's code at its first decision; bridge updates only reach NEW sessions
// (live sessions keep the pre-update bridge until they end).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createJiti } from "@mariozechner/jiti";

const JEV_EXTENSION =
  "/Users/olivier/.pi/agent/git/github.com/shopify-playground/shop-pi-fy/extensions/jev/index.ts";
const MODEL = process.env.JEV_MODEL || "jev-latest";
const OUTPUT_LIMIT = 400;
// Parent-authored text (goals, mid-run parent messages) rides at 2000 so the
// actionable tail survives (A3); tool/notification output stays at 400.
const TEXT_LIMIT = 2000;

function fail(message) {
  process.stderr.write(`jev-bridge: ${message}\n`);
  process.exit(1);
}

// The extension expects an exec(bin, args, {signal, timeout}) -> {code, stdout, stderr, killed}
function makeExecutor() {
  return {
    exec(bin, args, opts = {}) {
      return new Promise((resolve) => {
        const child = spawn(bin, args, { signal: opts.signal });
        let stdout = "";
        let stderr = "";
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, opts.timeout ?? 15000);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ code: 1, stdout, stderr: String(err), killed });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, stdout, stderr, killed });
        });
      });
    },
  };
}

function readStdinLines(onLine) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  });
}

export function digestEvents(events) {
  return events.slice(-30).map((e) => {
    switch (e.type) {
      case "user_input":
      case "parent_message":
      case "reminder":
        return { kind: e.type, text: String(e.text).slice(0, TEXT_LIMIT) };
      case "decision":
        return {
          kind: "decision",
          say: e.say?.slice(0, 200),
          called: e.calls?.map((c) => c.tool),
        };
      case "tool_result":
        return {
          kind: "tool_result",
          tool: e.tool,
          isError: e.isError ?? false,
          output: String(e.output ?? "").slice(0, OUTPUT_LIMIT),
        };
      case "fault":
        return { kind: "fault", message: e.message.slice(0, 200) };
      case "notification":
        // Worker notices and report pointers ride in the text — without it
        // jev cannot see that delegated work finished.
        return { kind: "notification", notification: e.kind, text: String(e.text ?? "").slice(0, OUTPUT_LIMIT) };
      default:
        return { kind: e.type };
    }
  });
}

/** Spawn calls by callId, so a spawn tool result links back to its name/agent. */
function callArgsById(events) {
  const map = new Map();
  for (const e of events) {
    if (e.type === "decision" && Array.isArray(e.calls)) {
      for (const c of e.calls) map.set(c.id, c);
    }
  }
  return map;
}

/**
 * Every worker this orchestrator has spawned, keyed by STABLE CHILD ID —
 * display names are presentation only (same-name children are distinct rows).
 * Identity = stable child id + canonical session chain + attempt; rows carry
 * the assigned task ids and the arm purpose (work/think/...), never special
 * agent names.
 *
 * Lifecycle states: spawn_pending/running/completed/failed/killed/interrupted/
 * resumed/exited-without-done. An emitted call is not an executed call: intent
 * (decision call), acknowledgement (tool_result) and effect (transition) are
 * journal phases, folded through a guarded state machine so an old spawn
 * replay can never overwrite a newer durable kill/interruption. Kill emits no
 * subagent_result — a killed row comes only from the kill tool acknowledgement.
 */
const LIFECYCLE_STATES = [
  "spawn_pending", "running", "completed", "failed",
  "killed", "interrupted", "resumed", "exited-without-done",
];

const TRANSITIONS = {
  spawn_pending: ["running", "killed", "exited-without-done", "interrupted", "completed", "failed"],
  running: ["completed", "failed", "interrupted", "killed", "exited-without-done"],
  interrupted: ["completed", "failed", "killed", "exited-without-done"],
  killed: [],
  completed: [],
  failed: [],
  // Resume eligibility: only a child that exited without reporting done may
  // be resumed (P6 ruling); completed/failed/killed work is never resumed.
  "exited-without-done": ["completed", "failed", "resumed"],
  resumed: ["completed", "failed", "interrupted", "killed", "exited-without-done"],
};

export function canTransition(from, to) {
  return from === to || TRANSITIONS[from].includes(to);
}

export function emptyReceipts() {
  return {
    v: 1,
    lifecycle: {},
    operations: {},
    consumedCompletions: [],
    resumeReservations: {},
    foldedEventCount: 0,
  };
}

function applyLifecycle(receipts, childId, state, ts, fields = {}) {
  const previous = receipts.lifecycle[childId];
  if (previous && !canTransition(previous.state, state)) return false;
  // Merge over the previous row: identity (name/agent/taskIds/purpose) and
  // attempt survive every transition.
  receipts.lifecycle[childId] = {
    ...(previous ?? {}),
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    childId,
    state,
    stateTs: ts,
    attempt: fields.attempt ?? previous?.attempt,
    purpose: fields.purpose ?? previous?.purpose,
  };
  return true;
}

function mergeReceipts(target, raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "unrecognized .orch.json shape" };
  if (raw.v !== 1) return { ok: false, error: `unknown .orch.json version ${raw.v}` };
  if (raw.lifecycle != null && (typeof raw.lifecycle !== "object" || Array.isArray(raw.lifecycle))) {
    return { ok: false, error: "malformed .orch.json lifecycle" };
  }
  for (const [childId, row] of Object.entries(raw.lifecycle ?? {})) {
    if (!row || typeof row !== "object" || !LIFECYCLE_STATES.includes(row.state)) {
      return { ok: false, error: "malformed .orch.json lifecycle row" };
    }
    const existing = target.lifecycle[childId];
    // A durable terminal state stands: an older spawn row never overwrites it.
    if (!existing || row.stateTs >= existing.stateTs) target.lifecycle[childId] = row;
  }
  for (const [id, operation] of Object.entries(raw.operations ?? {})) {
    target.operations[id] = { ...operation, ...target.operations[id] };
  }
  for (const id of raw.consumedCompletions ?? []) {
    if (!target.consumedCompletions.includes(id)) target.consumedCompletions.push(id);
  }
  Object.assign(target.resumeReservations, raw.resumeReservations ?? {});
  target.foldedEventCount = Math.max(target.foldedEventCount, raw.foldedEventCount ?? 0);
  return { ok: true };
}

/** Load `<session>.orch.json`; corrupt or unrecognized state is returned as
 *  corrupt so the engine escalates instead of proceeding on an empty ledger. */
export function readOrchReceipts(sessionFile) {
  const receipts = emptyReceipts();
  if (!sessionFile) return { receipts, corrupt: false };
  let raw;
  try {
    raw = readFileSync(`${sessionFile}.orch.json`, "utf8");
  } catch {
    return { receipts, corrupt: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { receipts, corrupt: true, error: `.orch.json is not parsable: ${error.message}` };
  }
  const merged = mergeReceipts(receipts, parsed);
  return merged.ok ? { receipts, corrupt: false } : { receipts, corrupt: true, error: merged.error };
}

/** Atomic receipt write: temp + rename, never a partial ledger. */
export function saveOrchReceipts(sessionFile, receipts) {
  if (!sessionFile) return { ok: true };
  const target = `${sessionFile}.orch.json`;
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(receipts, null, 2)}\n`);
    renameSync(temp, target);
    return { ok: true };
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {}
    return { error: `receipt write failed: ${error?.message ?? error}` };
  }
}

/** Legacy `<session>.workers.json` rows fold in as attempt-1 spawn rows; new
 *  writes go to `.orch.json` only. Unreadable legacy rows are skipped. */
export function migrateLegacyWorkers(receipts, legacyRows) {
  if (!Array.isArray(legacyRows)) return;
  for (const row of legacyRows) {
    if (!row || typeof row !== "object" || typeof row.name !== "string") continue;
    const childId = typeof row.child_id === "string" && row.child_id ? row.child_id : `legacy:${row.name}`;
    if (receipts.lifecycle[childId]) continue;
    const state = row.completed ? "completed" : row.spawn_failed ? "spawn_pending" : row.child_id ? "running" : "spawn_pending";
    receipts.lifecycle[childId] = {
      childId,
      name: row.name,
      ...(row.agent ? { agent: row.agent } : {}),
      purpose: "work",
      attempt: 1,
      state,
      stateTs: 0,
      ...(row.report_path ? { resultStorePath: row.report_path } : {}),
      ...(row.spawn_failed ? { spawnFailed: true } : {}),
    };
  }
}

/** Purpose from the spawn the bridge itself emitted: our own decision calls
 *  carry the mapping, so no agent-name heuristics are needed downstream. */
function purposeOfCall(call) {
  if (call?.tool !== "subagent") return undefined;
  const task = String(call.args?.task ?? "");
  const thinkerFor = /thinker_for: (\S+)/.exec(task);
  return thinkerFor ? "think" : "work";
}

/**
 * Fold transcript events onto the receipts. Events only ADD: each index folds
 * once (`foldedEventCount` guards replay after reload), and lifecycle moves
 * through the guarded state machine — a replayed spawn ack cannot regress a
 * durable kill/interruption, and a completion after a kill is a phantom.
 */
export function foldEvents(receipts, events) {
  let changed = false;
  const start = receipts.foldedEventCount;
  const calls = callArgsById(events);
  for (let i = start; i < events.length; i++) {
    const e = events[i];
    if (e.type === "decision" && Array.isArray(e.calls)) {
      for (const c of e.calls) {
        if (c?.tool !== "subagent") continue;
        const operationId = `spawn:${c.id}`;
        if (receipts.operations[operationId]?.intent) continue;
        const key = `call:${c.id}`;
        receipts.operations[operationId] = {
          intent: { tool: "subagent", phase: "intent", childKey: key },
        };
        applyLifecycle(receipts, key, "spawn_pending", Date.now(), {
          name: String(c.args?.name ?? "Goal worker"),
          agent: c.args?.agent ?? null,
          purpose: purposeOfCall(c),
          attempt: 1,
          taskIds: Array.isArray(c.args?.tasks) ? c.args.tasks : undefined,
          askId: /thinker_for: (\S+)/.exec(String(c.args?.task ?? ""))?.[1],
        });
        changed = true;
      }
    } else if (e.type === "tool_result" && e.tool === "subagent") {
      const operationId = `spawn:${e.callId}`;
      const intent = receipts.operations[operationId]?.intent;
      if (!intent || receipts.operations[operationId].acknowledgement) continue;
      receipts.operations[operationId].acknowledgement = { phase: "acknowledgement", isError: Boolean(e.isError) };
      const key = intent.childKey;
      const row = receipts.lifecycle[key];
      if (e.isError) {
        if (row) {
          row.spawnFailed = true;
          changed = true;
        }
        continue;
      }
      const childId = /Id:\s*([0-9a-f-]{6,})/i.exec(String(e.output ?? ""))?.[1];
      if (childId && row) {
        delete receipts.lifecycle[key];
        receipts.lifecycle[childId] = { ...row, childId };
        applyLifecycle(receipts, childId, "running", Date.now(), {});
        receipts.operations[operationId].acknowledgement.childId = childId;
        changed = true;
      }
    } else if (e.type === "tool_result" && ["subagent_kill", "subagent_interrupt", "subagent_resume"].includes(e.tool)) {
      const state = e.tool === "subagent_kill" ? "killed" : e.tool === "subagent_interrupt" ? "interrupted" : "resumed";
      // The control call's args (intent, matched by callId) name the target.
      const args = calls.get(e.callId)?.args ?? {};
      const rows = Object.values(receipts.lifecycle);
      const byId = args.id ?? args.subagentId;
      const candidates = byId
        ? rows.filter((r) => r.childId === byId)
        : e.tool === "subagent_resume" && args.sessionPath
          ? rows.filter((r) => r.sessionFile === args.sessionPath)
          : rows.filter((r) => r.name === args.name);
      // A resume with only a session path falls back to the single
      // exited-without-done row — the only resume-eligible state.
      const resolved = candidates.length === 1 ? candidates : candidates.length === 0 && e.tool === "subagent_resume"
        ? rows.filter((r) => r.state === "exited-without-done")
        : candidates;
      const row = resolved.length === 1 ? resolved[0] : undefined;
      // Only an acknowledged control action moves the ledger; a failed
      // interrupt/kill leaves the child in its current state.
      if (!row || e.isError) continue;
      if (e.tool === "subagent_resume") {
        // The resumed attempt is a NEW child on the old session chain: the
        // old row records the resume, the new row carries attempt+1 and the
        // preserved purpose.
        applyLifecycle(receipts, row.childId, "resumed", Date.now(), {});
        const newChildId = /Id:\s*([0-9a-f-]{6,})/i.exec(String(e.output ?? ""))?.[1];
        if (newChildId && newChildId !== row.childId) {
          receipts.lifecycle[newChildId] = {
            ...row,
            childId: newChildId,
            attempt: (row.attempt ?? 1) + 1,
            resumedFrom: args.sessionPath ?? row.sessionFile ?? null,
            state: "resumed",
            stateTs: Date.now(),
          };
        }
        changed = true;
        continue;
      }
      if (!applyLifecycle(receipts, row.childId, state, Date.now())) continue;
      changed = true;
    } else if (e.type === "notification" && e.kind === "subagent_result") {
      const payload = e.payload ?? {};
      const rows = Object.values(receipts.lifecycle);
      const childId = String(payload.id ?? payload.childId ?? "");
      const row = childId
        ? rows.find((r) => r.childId === childId)
        : payload.name
          ? rows.filter((r) => r.name === payload.name)
          : [];
      const target = Array.isArray(row) ? (row.length === 1 ? row[0] : undefined) : row;
      if (!target) continue;
      const completionId = `${target.childId}:${payload.resultStorePath ?? e.ts ?? i}`;
      if (receipts.consumedCompletions.includes(completionId)) continue;
      receipts.consumedCompletions.push(completionId);
      // Explicit completionKind from the parent's watcher/.exit facts. Legacy
      // notices without one are never task success: an unknown clean exit
      // folds as exited-without-done, never "completed".
      const kind = payload.completionKind
        ?? (payload.interrupted ? "interrupted"
          : payload.lost ? "exited-without-done"
            : (payload.exitCode ?? 0) !== 0 || payload.errorMessage ? "failed" : "exited-without-done");
      applyLifecycle(receipts, target.childId, kind, Date.now(), {
        completionKind: kind,
        ...(payload.resultStorePath ? { resultStorePath: payload.resultStorePath } : {}),
      });
      // The store holds the full report; the notice text is the fallback.
      let report = String(e.text ?? "");
      if (payload.resultStorePath) {
        try {
          report = readFileSync(String(payload.resultStorePath), "utf8");
        } catch {
          // Store unreadable — the notice text still carries the essentials.
        }
      }
      receipts.lifecycle[target.childId].report = report.slice(0, 4000);
      changed = true;
    }
  }
  if (events.length > receipts.foldedEventCount) {
    receipts.foldedEventCount = events.length;
    changed = true;
  }
  return changed;
}

/**
 * Merge the durable receipts (folded from the full transcript on every build
 * pass) with the event fold and persist the merge. Corrupt or unwritable
 * ledgers surface as flags — the engine must escalate, never converge on an
 * empty ledger.
 */
export function mergedWorkers(sessionFile, events) {
  const loaded = readOrchReceipts(sessionFile);
  const receipts = loaded.receipts;
  if (!loaded.corrupt && !receipts.foldedEventCount) {
    try {
      const rows = JSON.parse(readFileSync(`${sessionFile}.workers.json`, "utf8"));
      migrateLegacyWorkers(receipts, rows);
    } catch {
      // No legacy ledger — a fresh one starts here.
    }
  }
  foldEvents(receipts, events);
  const ledger = { corrupt: loaded.corrupt === true, error: loaded.error, writeError: null };
  if (loaded.corrupt) {
    return { rows: workerRows(receipts), ledger };
  }
  if (sessionFile) {
    const saved = saveOrchReceipts(sessionFile, receipts);
    if (saved.error) ledger.writeError = saved.error;
  }
  return { rows: workerRows(receipts), ledger };
}

/** The worker view over a lifecycle row: booleans the engine reasons with,
 *  plus the stable identity, state and purpose. */
function workerRows(receipts) {
  return Object.values(receipts.lifecycle).map((row) => {
    let report = row.report ?? null;
    if (!report && row.resultStorePath) {
      try {
        report = readFileSync(String(row.resultStorePath), "utf8").slice(0, 4000);
      } catch {
        // Store unreadable — the pointer still stands.
      }
    }
    return ({
    child_id: row.childId.startsWith("call:") ? null : row.childId,
    name: row.name,
    agent: row.agent ?? null,
    purpose: row.purpose ?? null,
    attempt: row.attempt ?? 1,
    session_file: row.sessionFile ?? null,
    state: row.state,
    running: ["running", "interrupted", "resumed"].includes(row.state),
    spawn_failed: row.spawnFailed === true,
    completed: row.state === "completed",
    askId: row.askId ?? null,
    task_ids: row.taskIds ?? [],
    resume_eligible: row.resumeEligible === true,
    resumed_from: row.resumedFrom ?? null,
    completion_kind: row.completionKind ?? null,
    verdict: row.state === "completed" ? "done" : null,
    report,
    report_path: row.resultStorePath ?? null,
  });
  });
}

/** D1: outstanding-work lines never budgeted away, whatever the slice. */
const OUTSTANDING_LINE = /\b(approv\w*|review\w*|outstanding|blocked|not (obtained|completed))\b/i;

function outstandingLines(report) {
  return String(report)
    .split("\n")
    .filter((line) => OUTSTANDING_LINE.test(line))
    .map((line) => line.slice(0, 400));
}

/** D1: all rows always; the 3 most recent completed reports in full, older ones
 *  head-cut with a store pointer — and outstanding-work lines always kept. */
export function budgetWorkerRows(workers) {
  const completedAt = [];
  workers.forEach((w, i) => {
    if (w.completed && w.report) completedAt.push(i);
  });
  const full = new Set(completedAt.slice(-3));
  return workers.map((w, i) => {
    const row = {
      name: w.name,
      agent: w.agent,
      child_id: w.child_id,
      purpose: w.purpose,
      attempt: w.attempt,
      state: w.state,
      task_ids: w.task_ids,
      resume_eligible: w.resume_eligible,
      resumed_from: w.resumed_from,
      completion_kind: w.completion_kind,
      running: w.running,
      spawn_failed: w.spawn_failed,
      completed: w.completed,
      verdict: w.verdict,
      report_path: w.report_path ?? null,
      report: null,
    };
    if (!w.completed || !w.report) return row;
    if (full.has(i)) {
      row.report = String(w.report).slice(0, 4000);
      return row;
    }
    const report = String(w.report);
    const kept = outstandingLines(report);
    row.report =
      report.slice(0, 400) +
      (kept.length > 0 ? `\n[outstanding work kept from the full report]\n${kept.join("\n")}` : "") +
      (row.report_path ? `\n[full report: ${row.report_path}]` : "");
    return row;
  });
}

/** B1: child→parent asks still unanswered — `ask` notifications minus later
 *  `answer` notifications, this bridge's own answer/dismiss calls. */
export function pendingAsks(events) {
  const asks = new Map();
  for (const e of events) {
    if (e.type === "notification" && e.kind === "ask") {
      const askId = String(e.payload?.askId ?? "");
      if (askId) {
        asks.set(askId, {
          askId,
          from: String(e.payload?.name ?? e.payload?.agent ?? "child"),
          text: String(e.payload?.question ?? e.text ?? "").slice(0, 1500),
        });
      }
    } else if (e.type === "notification" && e.kind === "answer") {
      asks.delete(String(e.payload?.askId ?? ""));
    } else if (e.type === "decision" && Array.isArray(e.calls)) {
      for (const c of e.calls) {
        if (c?.tool === "subagent_answer_child" || c?.tool === "dismiss_ask") {
          asks.delete(String(c.args?.askId ?? ""));
        }
      }
    }
  }
  return [...asks.values()];
}

/** E1/E3 and B3 one-shot markers: prior subagent/ask_parent calls carrying
 *  `thinker_for: <askId>` / `escalation_for: <askId>` in their task/question. */
function dispatchedWithMarker(events, tool, marker) {
  return events.some(
    (e) =>
      e.type === "decision" &&
      Array.isArray(e.calls) &&
      e.calls.some((c) => {
        if (c?.tool !== tool) return false;
        const text = String(c.args?.task ?? c.args?.question ?? "");
        return text.includes(marker);
      }),
  );
}

function thinkerDispatched(events, askId) {
  return dispatchedWithMarker(events, "subagent", `thinker_for: ${askId}`);
}

function escalationSent(events, askId) {
  return (
    dispatchedWithMarker(events, "subagent_ask_parent", `escalation_for: ${askId}`) ||
    events.some(
      (e) =>
        e.type === "decision" &&
        Array.isArray(e.calls) &&
        e.calls.some((c) => c?.tool === "escalate" && String(c.args?.key ?? "") === askId),
    )
  );
}

/** E2: the thinker's verdict — first JSON object in the report, prose tolerated. */
export function parseThinkerReport(report) {
  const text = String(report);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    if (
      parsed &&
      (parsed.kind === "response" || parsed.kind === "escalation_request") &&
      typeof parsed.text === "string"
    ) {
      return parsed;
    }
  } catch {
    // fall through — unparsable is an escalation, never a re-think (E3)
  }
  return null;
}

/** E2: the first completed thinker worker whose target ask is still pending. */
function unconsumedThinker(workers, asks) {
  for (const w of workers) {
    if (w.purpose !== "think" || !w.completed || !w.report || !w.askId) continue;
    const ask = asks.find((a) => a.askId === w.askId);
    if (ask) return { worker: w, ask };
  }
  return null;
}

/** B3: route an escalation upward by capability — root Inbox row, parent ask,
 *  or a terminal NOT-completed report the LLM parent must surface. A
 *  forwarded ask's answer auto-chains to the asking child without waking this
 *  session (the child's subagent_done converges the run). */
function escalateAction(req, { key, title, body, markerAskId, forwardAskId = null }) {
  const marker = markerAskId ? `escalation_for: ${markerAskId}` : null;
  if (req.tools.some((t) => t.name === "escalate")) {
    return {
      say: `Escalating to the user's Inbox: ${title}`,
      calls: [
        {
          tool: "escalate",
          args: {
            update: true,
            key,
            // Inbox caps: title 60, summary 80 (a long askId must not fault the call).
            title: title.slice(0, 60),
            summary: title.slice(0, 80),
            description: `${body}${marker ? `\n\n${marker}` : ""}`,
          },
          reason: "pending ask/blocker escalated to the user's Inbox",
        },
      ],
    };
  }
  if (req.tools.some((t) => t.name === "subagent_ask_parent")) {
    return {
      say: `Escalating to the parent: ${title}`,
      calls: [
        {
          tool: "subagent_ask_parent",
          args: {
            question: `ESCALATION REQUEST (needs the user)${marker ? ` — ${marker}` : ""}: ${title}\n\n${body}`,
            ...(forwardAskId
              ? { forwardAskId, message: `Child ask ${forwardAskId} forwarded: ${title}` }
              : {}),
          },
          reason: "pending ask/blocker escalated to the parent for the user",
        },
      ],
    };
  }
  return {
    terminal: true,
    say: `Escalating upward (terminal): ${title}`,
    calls: [
      {
        tool: "subagent_done",
        args: {
          result:
            `ESCALATION REQUEST${marker ? ` (${marker})` : ""}: ${title}\n\n` +
            `Goal was NOT completed — this result needs the user's attention, not a merge.\n\n${body}`,
        },
        reason: "no escalate/ask_parent capability; terminal escalation report",
      },
    ],
  };
}

/** The escalation body: every pending ask and dead-end blocker, in full enough. */
function escalationBody(asks, blockers, extra) {
  const parts = [];
  for (const a of asks) parts.push(`Pending ask ${a.askId} from "${a.from}":\n${a.text}`);
  for (const b of blockers) {
    parts.push(
      `Dead-end blocker: worker "${b.name}" (agent ${b.agent ?? "?"}) could not be spawned and no retry has succeeded.`,
    );
  }
  if (extra) parts.push(extra);
  return parts.join("\n\n") || "(nothing pending)";
}

/** True once subagent_done has executed successfully — the run is over. */
function doneAlreadyCalled(events) {
  return events.some(
    (e) => e.type === "tool_result" && e.tool === "subagent_done" && !e.isError,
  );
}

/** Failed subagent spawns at the tail of the events, broken by any successful spawn. */
function trailingSpawnFailures(events) {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "tool_result" || e.tool !== "subagent") continue;
    if (e.isError) n++;
    else break;
  }
  return n;
}

/** Failure report for the mechanical spawn dead-end: the classifier cannot read the error's instructions, so the loop converges upward instead. */
function spawnFailureReport(events, failures) {
  const last = [...events]
    .reverse()
    .find((e) => e.type === "tool_result" && e.tool === "subagent" && e.isError);
  const err = String(last?.output ?? "(no error text captured)").slice(0, 400);
  return (
    `Orchestrator aborted mechanically: ${failures} consecutive spawn attempts failed with no successful spawn between them. ` +
    `The goal was NOT completed.\n\nGoal: ${resolveGoal(events).slice(0, 400)}\n\nLast spawn error: ${err}`
  );
}

/** The goal text: the spawn's `PI_SUBAGENT_TASK` env when present (artifact handoff buries it in an expanded wrapper blob), else the first user/parent message. A1: the env text is memory-only and carries in full — the old 1000/4000 silent cuts hid the actionable half of the 2026-10-19 goal. */
export function resolveGoal(events) {
  const fromEnv = process.env.PI_SUBAGENT_TASK?.trim();
  if (fromEnv) return fromEnv;
  const raw =
    events.find((e) => e.type === "user_input")?.text ??
    events.find(
      (e) => e.type === "parent_message" || (e.type === "notification" && e.kind === "parent_message"),
    )?.text ??
    "(no goal message)";
  if (raw.startsWith("@")) {
    try {
      return readFileSync(raw.slice(1), "utf8").slice(0, 4000);
    } catch {
      // artifact unreadable — fall through to the raw handoff reference
    }
  }
  return raw;
}

/** This session's structured spawn args (the `<session>.args.json` sidecar), for engines whose parent spawns them with an argsSchema. */
function readSpawnArgs(sessionFile) {
  if (!sessionFile) return null;
  try {
    const raw = readFileSync(`${sessionFile}.args.json`, "utf8").trim();
    return raw ? raw.slice(0, 1500) : null;
  } catch {
    return null;
  }
}

/** Worker-agent choices from the request roster; the generic trio when no roster is published. The orchestrator's own agent is never offered — self-spawn is blocked upstream and picking it just burns retries. */
function workerAgentQuestion(req) {
  const roster = Array.isArray(req.roster) ? req.roster : [];
  const self = req.agent?.agentType ?? req.agent?.name ?? null;
  if (roster.length === 0) {
    return {
      type: "choice",
      instructions:
        "If a worker is spawned for `state.goal`, which agent type fits the work described there best?",
      criteria: {
        worker: "General doing: implementing, running commands, tests, builds, commits.",
        scout: "Read-only checking: verifying claims, inspecting code or state, research.",
        monitor: "Watching one resource over time and reporting on change.",
        other: "None of these fit.",
      },
    };
  }
  const criteria = {};
  for (const a of roster.slice(0, 30)) {
    if (self && a.name === self) continue;
    criteria[a.name] = String(a.description ?? `Agent ${a.name}.`).slice(0, 160);
  }
  criteria.other = "None of these fit.";
  return {
    type: "choice",
    instructions:
      "If a worker is spawned for `state.goal`, which agent from the roster fits the work best? Pick by exact name.",
    criteria,
  };
}

/** Which running worker a check-in goes to — only asked when there is more than one. */
function checkInTargetQuestion(workers) {
  const running = workers.filter((w) => w.running && w.child_id);
  if (running.length <= 1) return undefined;
  const criteria = {};
  for (const w of running) criteria[w.name] = `Status-check the ${w.agent ?? "worker"} named ${w.name}.`;
  criteria.none = "No check-in is needed.";
  return {
    type: "choice",
    instructions: "Which running worker should this status check go to?",
    criteria,
  };
}

/** A1: `state.goal` carries the first 4000 chars; anything longer lands whole
 *  in a `<session>.goal.txt` sidecar with an explicit pointer — never a silent
 *  cut (without a sidecar path the goal rides whole instead). */
export function goalForState(goal, sessionFile) {
  if (goal.length <= 4000 || !sessionFile) return { goal, path: null, truncated: false };
  const path = `${sessionFile}.goal.txt`;
  try {
    writeFileSync(path, goal, "utf8");
  } catch {
    return { goal, path: null, truncated: false }; // unwritable sidecar — carry the goal whole
  }
  return {
    goal: `${goal.slice(0, 4000)}\n[goal truncated — full text at ${path}]`,
    path,
    truncated: true,
  };
}

export function buildRequest(req) {
  const goal = resolveGoal(req.events);
  const { rows: workers, ledger } = mergedWorkers(req.agent?.sessionFile, req.events);
  const asks = pendingAsks(req.events);
  const carriers = goalForState(goal, req.agent?.sessionFile);
  const doneCalled = doneAlreadyCalled(req.events);
  const agentQuestion = workerAgentQuestion(req);
  const targetQuestion = checkInTargetQuestion(workers);
  return {
    model: MODEL,
    state: {
      goal: carriers.goal,
      ...(carriers.truncated
        ? { goal_full_path: carriers.path, goal_truncated: true }
        : {}),
      agent_instructions: String(req.instructions ?? "").slice(0, 800),
      available_tools: req.tools.map((t) => t.name),
      spawn_args: readSpawnArgs(req.agent?.sessionFile),
      workers: budgetWorkerRows(workers),
      pending_asks: asks,
      blockers: workers
        .filter((w) => w.spawn_failed)
        .map((w) => ({ name: w.name, agent: w.agent })),
      done_already_reported: doneCalled,
      recent_events: digestEvents(req.events),
      run_state: req.state ?? null,
      // A corrupt or unwritable ledger blocks convergence (never a silent
      // empty-ledger fallback): mapAnswers refuses done and escalates.
      ...(ledger.corrupt ? { ledger_corrupt: true, ledger_error: ledger.error } : {}),
      ...(!ledger.corrupt && ledger.writeError ? { ledger_write_error: ledger.writeError } : {}),
    },
    questions: {
      done: {
        type: "noul",
        instructions:
          "Given `state.goal` and `state.recent_events` (including any completed worker reports in `state.workers`), is the goal fully achieved with nothing important left to do?",
      },
      next_action: {
        type: "choice",
        instructions:
          "What should the orchestrator do on this turn, given `state.goal`, `state.workers` (name / agent / running / spawn_failed / completed / verdict / report), `state.pending_asks`, `state.blockers` and `state.recent_events`?",
        criteria: {
          spawn_worker:
            "A piece of the goal's work has no worker yet (never spawned, or a spawn failed and should be retried), or a worker finished and clearly more delegated work remains. Multiple workers may run in parallel or sequence.",
          wait:
            "Workers are running and not all of their results have arrived (`state.workers` still has `running: true`); the orchestrator should do nothing this turn.",
          report_done:
            "All delegated work is finished (every spawned worker completed with done verdicts) or the goal conclusively cannot proceed; report the outcome upward now.",
          check_in:
            "A running worker may be stuck or off-course; a brief status check to it is warranted.",
          think:
            "A pending child ask or blocker needs reasoning beyond mechanical routing; dispatch the thinker once with the decision context.",
          escalate:
            "A pending child ask or a dead-end blocker exists that the orchestrator cannot resolve mechanically; surface it upward now (the parent routes it to the user or a thinker).",
          other: "None of these describe the current situation.",
        },
      },
      worker_agent: agentQuestion,
      ...(targetQuestion ? { check_in_target: targetQuestion } : {}),
    },
  };
}

/** One converged result from every completed worker's report. */
export function convergeReport(workers, done, next) {
  const completed = workers.filter((w) => w.completed && w.report);
  if (completed.length === 0) {
    return `No worker reports were received (jev: done=${done.toFixed(2)}, next=${next}).`;
  }
  return completed
    .map(
      (w) =>
        `Worker "${w.name}" (agent ${w.agent ?? "?"}, verdict ${w.verdict ?? "unknown"}):\n${w.report.trim()}`,
    )
    .join("\n\n---\n\n")
    .slice(0, 4000);
}

/** E1: the budgeted decision state as text — the same picture jev sees. */
function decisionStateText(req, goal, workers) {
  const carriers = goalForState(goal, req.agent?.sessionFile);
  const rows = budgetWorkerRows(workers);
  const workerLines = rows.map(
    (r) =>
      `- ${r.name} (${r.agent ?? "?"}, ${
        r.completed
          ? `completed, verdict ${r.verdict ?? "?"}`
          : r.running
            ? "running"
            : r.spawn_failed
              ? "spawn_failed"
              : "spawned"
      })${r.report ? `\n  report: ${r.report}` : ""}`,
  );
  return `Goal:\n${carriers.goal}\n\nWorkers:\n${workerLines.join("\n") || "(none)"}`;
}

export function mapAnswers(answers, req) {
  // The report was already delivered — never call subagent_done twice.
  if (doneAlreadyCalled(req.events)) {
    return { terminal: true, say: "Already reported done; ending.", calls: [] };
  }
  // Mechanical dead-end: repeated failed spawns never resolve by asking the
  // classifier again (self-spawn blocks, bad agent choices, missing cwd).
  const failures = trailingSpawnFailures(req.events);
  if (failures >= 3) {
    return {
      terminal: true,
      say: `${failures} consecutive spawns failed; reporting the failure upward.`,
      calls: [
        {
          tool: "subagent_done",
          args: { result: spawnFailureReport(req.events, failures) },
          reason: "mechanical fallback after 3 consecutive spawn failures",
        },
      ],
    };
  }
  const done = answers.done?.noul ?? 0;
  const next = answers.next_action?.choice ?? "other";
  const agentType =
    answers.worker_agent?.choice && answers.worker_agent.choice !== "other"
      ? answers.worker_agent.choice
      : "worker";
  const goal = resolveGoal(req.events);
  const { rows: workers, ledger } = mergedWorkers(req.agent?.sessionFile, req.events);
  const asks = pendingAsks(req.events);
  const blockers = workers.filter((w) => w.spawn_failed);
  // Leaf sessions (PI_DENY_TOOLS) have no spawn tools; emitting them faults every repair attempt.
  const canSpawn = req.tools.some((t) => t.name === "subagent");
  const canAnswerChild = req.tools.some((t) => t.name === "subagent_answer_child");

  // Corrupt or unwritable ledger: convergence may never succeed on an
  // unfaithful picture — stop and infra-escalate instead.
  if (ledger.corrupt || ledger.writeError) {
    const problem = ledger.corrupt
      ? `orchestration ledger corrupt: ${ledger.error}`
      : `orchestration ledger write failed: ${ledger.writeError}`;
    return escalateAction(req, {
      key: "ledger-corrupt",
      title: "Decision orchestrator cannot trust its worker ledger",
      body:
        `${problem}. The run was NOT completed — worker lifecycle state cannot be proven, ` +
        `so no convergence or task completion may be recorded.`,
    });
  }

  // E2: route a completed thinker's report — answer the asking child, or
  // escalate its finding upward (unparsable is an escalation, never a re-think).
  const thinker = unconsumedThinker(workers, asks);
  if (thinker) {
    const parsed = parseThinkerReport(thinker.worker.report);
    if (parsed?.kind === "response" && canAnswerChild) {
      return {
        say: `Answering ${thinker.ask.from} on ask ${thinker.ask.askId} with the thinker's response.`,
        calls: [
          {
            tool: "subagent_answer_child",
            args: { askId: thinker.ask.askId, answer: parsed.text },
            reason: "thinker response routed to the asking child",
          },
        ],
      };
    }
    if (escalationSent(req.events, thinker.ask.askId)) {
      return { say: "Thinker escalation already sent; waiting for the user.", calls: [] };
    }
    const finding =
      parsed?.kind === "escalation_request"
        ? parsed.text
        : `The thinker's report was unparsable and needs the user's judgement. Raw report (first 1500 chars):\n${String(thinker.worker.report).slice(0, 1500)}`;
    return escalateAction(req, {
      key: thinker.ask.askId,
      title: `Pending child ask ${thinker.ask.askId} from "${thinker.ask.from}" needs the user`,
      body: escalationBody([thinker.ask], blockers, `Thinker's finding:\n${finding}`),
      markerAskId: thinker.ask.askId,
      forwardAskId: thinker.ask.askId,
    });
  }

  // E1: every pending child ask routes ONCE per askId through the thinker —
  // mechanical, not battery-gated (2026-10-19 live failure: the battery chose
  // escalate and the ask never reached a thinker). B3 below remains the route
  // when this session cannot spawn (leaf jev session).
  if (asks.length > 0 && canSpawn) {
    const ask = asks[0];
    if (thinkerDispatched(req.events, ask.askId)) {
      return { say: "Thinker already dispatched; waiting for its report.", calls: [] };
    }
    const name = `thinker-${ask.askId}`;
    const task =
      `thinker_for: ${ask.askId}\n\n` +
      `A child of this orchestrator is blocked on a pending ask; reason about it beyond mechanical routing.\n\n` +
      `Pending ask ${ask.askId} from "${ask.from}":\n${ask.text}\n\n` +
      `Decision state (the same budgeted picture the orchestrator's engine sees):\n\n${decisionStateText(req, goal, workers)}\n\n` +
      `Decide: answer the asking child yourself, or surface the matter to the user. Return exactly one fenced JSON block:\n` +
      '```json\n{"kind": "response" | "escalation_request", "text": "...", "reasoning": "..."}\n```\n' +
      `For kind "response", text is the answer delivered verbatim to the asking child. For kind "escalation_request", text is what the user must see.`;
    return {
      say: `Dispatching the thinker for ask ${ask.askId}.`,
      calls: [
        {
          tool: "subagent",
          args: {
            name,
            agent: "thinker",
            thinking: "medium",
            model: "fireworks-300k/fireworks:accounts/fireworks/models/glm-5p3",
            task,
            cwd: req.agent?.cwd ?? process.cwd(),
          },
          reason: "pending ask routed to the thinker once",
        },
      ],
    };
  }

  // B3: pending asks and dead-end blockers reach the user by capability.
  if (next === "escalate" && (asks.length > 0 || blockers.length > 0)) {
    const ask = asks[0];
    // One escalation per ask: a re-chosen escalate idles until answered.
    if (ask && escalationSent(req.events, ask.askId)) {
      return { say: "Escalation already sent; waiting for the answer.", calls: [] };
    }
    return escalateAction(req, {
      key: ask?.askId ?? "goal-blocker",
      title: ask
        ? `Pending child ask ${ask.askId} from "${ask.from}" needs the user`
        : "Decision orchestrator blocked by spawn failures",
      body: escalationBody(asks, blockers),
      markerAskId: ask?.askId ?? null,
      // Multi-ask: forward asks[0] only (the ask the key/marker names); the
      // remaining asks stay pending locally.
      forwardAskId: ask?.askId ?? null,
    });
  }

  // A4: a zero-worker turn must never exit as done while spawning is possible —
  // truncation can hide the real state, so verify mechanically instead.
  if ((done >= 0.5 || next === "report_done") && workers.length === 0 && canSpawn) {
    const name = `Worker ${workers.length + 1}`;
    const task =
      `You are ${name}: the decision engine believes the goal may already be achieved. ` +
      `Verify the goal below is fully done; if anything remains, do it; report either way via subagent_done.\n\n` +
      goal;
    return {
      say: `Zero workers with a done-leaning verdict; spawning ${name} (${agentType}) to verify.`,
      calls: [
        {
          tool: "subagent",
          args: { name, agent: agentType, task, cwd: req.agent?.cwd ?? process.cwd() },
          reason: "zero-worker guard: verify before exiting as done",
        },
      ],
    };
  }

  if (done >= 0.5 || next === "report_done") {
    // No successful convergence with unresolved operations: a live child
    // (running, interrupted-but-live, or resumed) blocks the done report.
    const live = workers.filter((w) => w.running);
    if (live.length > 0) {
      return {
        say: `Holding: ${live.map((w) => `"${w.name}" (${w.state})`).join(", ")} still live — waiting for their results.`,
        calls: [],
      };
    }
    // Converge: the report the parent receives is every worker's report, not a stub.
    return {
      terminal: true,
      say: `Goal complete: ${goal.slice(0, 200)}`,
      calls: [
        {
          tool: "subagent_done",
          args: { result: convergeReport(workers, done, next) },
          reason: "jev judged the goal achieved",
        },
      ],
    };
  }
  if (next === "spawn_worker" && !canSpawn) {
    // A leaf session can only terminate cleanly with an explanatory report; holding would idle-loop.
    return {
      terminal: true,
      say: "No spawn tool in this session's toolset; reporting upward.",
      calls: [
        {
          tool: "subagent_done",
          args: {
            result:
              "Decision engine cannot act on this goal: this session's toolset has no `subagent` spawn tool, so delegated execution is impossible here. Goal was NOT completed.\n\nGoal: " +
              goal.slice(0, 400),
          },
          reason: "spawn_worker selected but subagent tool unavailable",
        },
      ],
    };
  }
  // E1 now lives above the B3 escalate arm: pending asks route through the
  // thinker mechanically whenever the session can spawn (E3: one dispatch per
  // askId, ever), regardless of the battery's escalate/wait lean.
  if (next === "spawn_worker") {
    // The goal is orchestrator-facing; the worker needs its work, not the
    // orchestration meta-instructions (waiting, converging, watch-demo holds).
    // The worker's own name leads, so a goal that splits work by worker
    // number is self-identifying for each spawn. Completed workers' reports
    // ride along — dependent pipelines (plan → implement) need the prior
    // stage's output, and forwarding it is mechanical, not generative.
    const name = `Worker ${workers.length + 1}`;
    const prior = workers.filter((w) => w.completed && w.report);
    const priorBlock =
      prior.length > 0
        ? "\n\nPrior completed worker reports (use them; do not redo that work):\n" +
          prior
            .map((w) => `— ${w.name} (${w.agent ?? "?"}):
${w.report.trim().slice(0, 1500)}`)
            .join("\n\n")
        : "";
    // A2: the goal rides in full — the old 2000-char cut starved every child
    // handoff whenever the actionable half sat past char 2000.
    const task =
      `You are ${name}: do the work below in one pass. Instructions about orchestrating, waiting, converging, or reporting upward are for your parent, not you — finish by calling subagent_done with your report.\n\n` +
      goal +
      priorBlock.slice(0, 4000);
    return {
      say: `Spawning ${name} (${agentType}) for the goal.`,
      calls: [
        {
          tool: "subagent",
          args: { name, agent: agentType, task, cwd: req.agent?.cwd ?? process.cwd() },
          reason: `jev selected spawn_worker/${agentType}`,
        },
      ],
    };
  }
  if (next === "check_in" && req.tools.some((t) => t.name === "subagent_ask_child")) {
    const running = workers.filter((w) => w.running && w.child_id);
    const chosen =
      running.find((w) => w.name === answers.check_in_target?.choice) ?? running[0];
    if (chosen) {
      return {
        say: `Checking in on ${chosen.name}.`,
        calls: [
          {
            tool: "subagent_ask_child",
            args: { subagentId: chosen.child_id, question: "Status check: how is the task going?" },
            reason: "jev selected check_in",
          },
        ],
      };
    }
  }
  // wait, or unmappable answers: end the turn without calls; worker events wake the loop.
  return {
    say: next === "wait" ? "Waiting for the running workers." : `Holding (jev: next=${next}).`,
    calls: [],
  };
}

// One decision request: envelope {id, request} from the provider's stdio
// transport (a bare DecisionRequest is accepted for manual testing).
async function decideOne(line, evaluateJev, resolveProxyToken) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    process.stderr.write(`jev-bridge: malformed line: ${e.message}\n`);
    return;
  }
  const id = message?.id ?? null;
  const req = message?.request ?? message;
  if (req?.v !== 1 || !Array.isArray(req.events) || !Array.isArray(req.tools)) {
    process.stderr.write("jev-bridge: not a pi-decision-v1 DecisionRequest\n");
    return;
  }
  try {
    const token = await resolveProxyToken(makeExecutor(), undefined);
    const response = await evaluateJev(buildRequest(req), token, undefined);
    const mapped = mapAnswers(response.answers, req);
    const result = {
      v: 1,
      ...mapped,
      diagnostics: {
        engine: "jev-bridge",
        model: response.model,
        answers: response.answers,
        usage: response.usage ?? null,
      },
    };
    process.stdout.write(JSON.stringify({ id, result }) + "\n");
  } catch (err) {
    process.stderr.write(`jev-bridge: decision failed: ${err?.stack || err}\n`);
    process.exit(1);
  }
}

// Boot is guarded so tests can import the pure functions without starting
// the stdio loop (A0).
if (process.env.JEV_BRIDGE_NO_BOOT !== "1") {
  try {
    const { evaluateJev, resolveProxyToken } = await createJiti(import.meta.url).import(JEV_EXTENSION);
    readStdinLines((line) => void decideOne(line, evaluateJev, resolveProxyToken));
  } catch (err) {
    fail(err?.stack || String(err));
  }
}
