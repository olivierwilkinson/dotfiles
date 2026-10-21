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
// A process pins this code only until it exits. Engine recovery may respawn
// from disk under a still-loaded extension, so request capabilities gate
// completion compatibility.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createJiti } from "@mariozechner/jiti";

const JEV_EXTENSION =
  "/Users/olivier/.pi/agent/git/github.com/shopify-playground/shop-pi-fy/extensions/jev/index.ts";
// Bump when the extension must distinguish a pinned, older bridge process.
export const BRIDGE_VERSION = 7;
if (process.argv.includes("--version")) {
  process.stdout.write(`jev-bridge ${BRIDGE_VERSION}\n`);
  process.exit(0);
}
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
const jiti = createJiti(import.meta.url);
const subagentsPath = process.env.JEV_SUBAGENTS_PATH ?? join(
  homedir(), ".pi/agent/git/github.com/olivierwilkinson/pi-subagents-extension/pi-extension/subagents",
);
let orchestrationJournal;
let completionDecisions;
let sessionMessages;
let statusReconciliation;
let recovery;
let convergenceContracts;
let convergence;
let inbox;
try {
  orchestrationJournal = await jiti.import(join(subagentsPath, "orchestration-journal.ts"));
  completionDecisions = await jiti.import(join(subagentsPath, "completion-decisions.ts"));
  sessionMessages = await jiti.import(join(subagentsPath, "session-messages.ts"));
  statusReconciliation = await jiti.import(join(subagentsPath, "status-reconciliation.ts"));
  recovery = await jiti.import(join(subagentsPath, "recovery.ts"));
  convergenceContracts = await jiti.import(join(subagentsPath, "convergence-contracts.ts"));
  convergence = await jiti.import(join(subagentsPath, "convergence.ts"));
  inbox = await jiti.import(join(subagentsPath, "inbox.ts"));
} catch (err) {
  fail(`Cannot load shared orchestration modules from JEV_SUBAGENTS_PATH=${subagentsPath}. ` +
    `Update the installed subagents extension and reload sessions before activating this bridge, ` +
    `or set JEV_SUBAGENTS_PATH to a compatible checkout. ${err?.message ?? err}`);
}
const { canTransition, emptyReceipts, applyLifecycle, loadOrchReceipts, mergeReceipts,
  saveOrchReceipts: saveSharedReceipts } = orchestrationJournal;
const { normalizeAcknowledgement } = sessionMessages;
export { canTransition, emptyReceipts };

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function readOrchReceipts(sessionFile) {
  if (!sessionFile) return { receipts: emptyReceipts(), corrupt: false };
  const loaded = loadOrchReceipts(sessionFile);
  return loaded.ok ? { receipts: loaded.receipts, corrupt: false }
    : { receipts: emptyReceipts(), corrupt: true, error: loaded.error };
}

export function saveOrchReceipts(sessionFile, receipts, discardedOperations = []) {
  // Validate bridge-authored rows, then preserve claims written by shared helpers during the fold.
  const validated = mergeReceipts(emptyReceipts(), receipts);
  if (!validated.ok) return { error: validated.error };
  if (!sessionFile) return {ok: true};
  const current = loadOrchReceipts(sessionFile);
  if (!current.ok) return {error: current.error};
  mergeReceipts(receipts, current.receipts);
  for (const id of discardedOperations) delete receipts.operations[id];
  return saveSharedReceipts(sessionFile, receipts);
}

/** Legacy `<session>.workers.json` rows fold in as attempt-1 spawn rows; new
 *  writes go to `.orch.json` only. Unreadable legacy rows are skipped. */
export function migrateLegacyWorkers(receipts, legacyRows) {
  if (!Array.isArray(legacyRows)) return;
  for (const row of legacyRows) {
    if (!row || typeof row !== "object" || typeof row.name !== "string") continue;
    const childId = typeof row.child_id === "string" && row.child_id ? row.child_id : `legacy:${row.name}`;
    if (receipts.lifecycle[childId]) continue;
    const state = row.completed
      ? row.verdict === "done" ? "completed" : ["failed", "failure", "error"].includes(row.verdict) ? "failed" : "exited-without-done"
      : row.spawn_failed ? "spawn_pending" : row.child_id ? "running" : "spawn_pending";
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

// Read-only migration fallback for thinkers still in flight after a v3 upgrade.
function legacyThinkerAskId(call) {
  if (call?.args?.purpose && call.args.purpose !== "think") return undefined;
  const slot = call?.spawn?.slot ?? call?.args?.spawnSlot;
  if (slot && !slot.startsWith("think:")) return undefined;
  return /(?:^|\n)thinker_for: (\S+)(?:\n|$)/.exec(String(call?.args?.task ?? ""))?.[1];
}

/** Purpose from the spawn the bridge itself emitted: our own decision calls
 *  carry the mapping, so no agent-name heuristics are needed downstream. */
function purposeOfCall(call) {
  if (call?.tool !== "subagent") return undefined;
  const slot = call.args?.spawnSlot ?? call.spawn?.slot;
  if (slot?.startsWith("status-scout:")) return "status_scout";
  if (slot?.startsWith("verification:") || slot?.startsWith("goal_status:")) return "verification_scout";
  if (slot?.startsWith("synthesis:")) return "synthesis";
  if (slot?.startsWith("task:")) return "work";
  if (slot?.startsWith("think:") || legacyThinkerAskId(call)) return "think";
  return call.args?.purpose ?? "work";
}

/** Persist and merge every bridge claim; a failed write blocks the acting turn. */
function persistClaim(sessionFile, receipts, record, errors = []) {
  const claimed = orchestrationJournal.claimOperation(receipts, record);
  if (!sessionFile) {
    errors.push("no durable orchestration journal");
    return false;
  }
  const saved = orchestrationJournal.updateReceipts(sessionFile, (current) =>
    orchestrationJournal.claimOperation(current, record));
  if (!saved.ok) { errors.push(saved.error); return false; }
  mergeReceipts(receipts, saved.receipts);
  return claimed || Boolean(saved.ok);
}

function reconcileMark(sessionFile, receipts, mark, disposition, extra = {}, errors = []) {
  if (!sessionFile) { errors.push("no durable reconciliation journal"); return false; }
  const saved = statusReconciliation.recordStatusReconciled(sessionFile, mark, disposition, extra);
  if (!saved.ok) { errors.push(saved.error); return false; }
  const loaded = loadOrchReceipts(sessionFile);
  if (!loaded.ok) { errors.push(loaded.error); return false; }
  mergeReceipts(receipts, loaded.receipts);
  return true;
}

function markOperationForSlot(slot) {
  const binding = /^status-scout:(.+):(\d+)$/.exec(slot ?? "");
  return binding ? `status-reconcile:${binding[1]}:${binding[2]}` : undefined;
}

function acknowledged(event) {
  return (event.acknowledgement ?? normalizeAcknowledgement(event)).successful;
}

function canonicalResumePath(path) {
  try {
    return recovery.canonicalSessionPath(path);
  } catch (error) {
    // A bad transcript path is no match, not a fault of the entire turn.
    process.stderr.write(`jev-bridge: cannot canonicalize resume path ${JSON.stringify(path)}: ${error?.message ?? error}; ignoring this target\n`);
    return undefined;
  }
}

/**
 * Re-fold the sliding transcript window on every pass. Operation ids and
 * stable completion ids deduplicate effects; lifecycle guards prevent an old
 * spawn acknowledgement from regressing a newer terminal state.
 */
export function foldEvents(receipts, events, capabilities, sessionFile, errors = []) {
  let changed = false;
  if (capabilities?.completionKind && receipts.operations["protocol:completion-kind"]) {
    delete receipts.operations["protocol:completion-kind"];
    changed = true;
  }
  const calls = callArgsById(events);
  for (const e of events) {
    if (e.type === "decision" && Array.isArray(e.calls)) {
      for (const c of e.calls) {
        const escalationKey = c?.tool === "escalate" ? c.args?.key
          : /escalation_for: ([^\s)]+)/.exec(String(c?.args?.question ?? c?.args?.result ?? ""))?.[1]?.replace(/:$/, "");
        if (escalationKey) {
          const operationId = `escalation:${escalationKey}`;
          const operation = receipts.operations[operationId];
          // Retry receipts track the latest attempt until one is accepted.
          if (!operation || (operation.acknowledgement?.isError !== false && operation.intent?.callId !== c.id)) {
            receipts.operations[operationId] = { intent: { phase: "intent", tool: c.tool, callId: c.id } };
            changed = true;
          }
        }
        if (["subagent_kill", "subagent_interrupt", "subagent_resume"].includes(c?.tool)) {
          const operationId = `control:${c.id}`;
          const operation = receipts.operations[operationId] ??= {};
          if (!operation.intent) {
            operation.intent = { phase: "intent", tool: c.tool, callId: c.id, childId: c.args?.id ?? c.args?.subagentId, detail: { args: c.args } };
            changed = true;
          }
        }
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
          taskIds: Array.isArray(c.args?.tasks) && c.args.tasks.every(Number.isInteger) ? c.args.tasks : undefined,
          askId: c.args?.askId ?? (c.spawn?.slot?.startsWith("think:") ? c.spawn.slot.slice(6) : legacyThinkerAskId(c)),
          spawnSlot: c.args?.spawnSlot ?? c.spawn?.slot,
          reconciliationOperationId: c.args?.reconciliationOperationId ?? markOperationForSlot(c.args?.spawnSlot ?? c.spawn?.slot),
          cwd: c.args?.cwd,
        });
        if (c.args?.tasks !== undefined && (!Array.isArray(c.args.tasks) || !c.args.tasks.every(Number.isInteger))) {
          Object.assign(receipts.operations[operationId].intent, {
            infraIssue: true, error: "spawn taskIds must be integers",
          });
        }
        changed = true;
      }
    } else if (e.type === "tool_result" && e.tool === "subagent") {
      const operationId = `spawn:${e.callId}`;
      const intent = receipts.operations[operationId]?.intent;
      if (!intent || receipts.operations[operationId].acknowledgement) continue;
      const successful = acknowledged(e);
      receipts.operations[operationId].acknowledgement = { phase: "acknowledgement", isError: !successful };
      changed = true;
      const key = intent.childKey;
      const row = receipts.lifecycle[key];
      if (!successful) {
        if (row) row.spawnFailed = true;
        continue;
      }
      const childId = e.details?.id ?? /Id:\s*([0-9a-f-]{6,})/i.exec(String(e.output ?? ""))?.[1];
      if (typeof childId === "string" && childId && row) {
        // Never replace an existing stable row with the pending spawn row:
        // an old acknowledgement cannot resurrect a killed/interrupted child.
        applyLifecycle(receipts, childId, "running", Date.now(), receipts.lifecycle[childId] ? {} : {
          ...row, sessionFile: e.details?.sessionFile,
        });
        if (key !== childId) delete receipts.lifecycle[key];
        receipts.operations[operationId].acknowledgement.childId = childId;
      }
    } else if (e.type === "tool_result" && ["subagent_kill", "subagent_interrupt", "subagent_resume"].includes(e.tool)) {
      const call = calls.get(e.callId);
      const operationId = `control:${e.callId}`;
      const operation = receipts.operations[operationId] ??= {};
      const args = call?.args ?? operation.intent?.detail?.args ?? {};
      const details = isRecord(e.details) ? e.details : {};
      if (operation.effect || operation.acknowledgement) continue;
      operation.intent ??= { phase: "intent", tool: e.tool, callId: e.callId };
      const successful = acknowledged(e);
      operation.acknowledgement = {
        phase: "acknowledgement", isError: !successful, status: details.status,
        childId: args.id ?? args.subagentId ?? operation.intent.childId ?? details.id ?? details.childId,
        ts: e.ts ?? Date.now(),
        ...(details.infraIssue || details.receiptError || details.corrupt
          ? { infraIssue: true, error: String(details.receiptError ?? details.error ?? "control acknowledgement reported infrastructure failure") }
          : {}),
      };
      changed = true;
      // Only an acknowledged control action moves the ledger; a failed
      // interrupt/kill leaves the child in its current state.
      if (!successful) continue;
      let state = e.tool === "subagent_kill" ? "killed" : e.tool === "subagent_interrupt" ? "interrupted" : "resumed";
      if (details.status !== undefined) {
        const allowed = e.tool === "subagent_kill" ? ["killed", "exited-without-done"]
          : e.tool === "subagent_interrupt" ? ["interrupted", "interrupt_requested"] : ["resumed", "started"];
        if (!allowed.includes(details.status)) {
          operation.acknowledgement.infraIssue = true;
          operation.acknowledgement.error = `unexpected ${e.tool} status: ${details.status}`;
          continue;
        }
        if (e.tool === "subagent_kill") state = details.status;
      }
      const rows = Object.values(receipts.lifecycle);
      const byId = args.id ?? args.subagentId ?? (e.tool !== "subagent_resume" ? details.id ?? details.childId : undefined);
      const sessionPath = e.tool === "subagent_resume" && args.sessionPath
        ? canonicalResumePath(args.sessionPath) : undefined;
      const candidates = e.tool === "subagent_resume" && args.sessionPath
        ? rows.filter((r) => sessionPath && r.sessionFile && !r.resumedBy && canonicalResumePath(r.sessionFile) === sessionPath)
        : byId ? rows.filter((r) => r.childId === byId)
          : rows.filter((r) => r.name === args.name);
      // Never guess an unrelated transcript when canonical-path lookup fails.
      const resolved = candidates;
      const row = resolved.length === 1 ? resolved[0] : undefined;
      if (!row) {
        operation.acknowledgement.infraIssue = true;
        operation.acknowledgement.error = `${e.tool} acknowledgement has no unambiguous lifecycle target`;
        continue;
      }
      operation.acknowledgement.childId = row.childId;
      if (e.tool === "subagent_resume") {
        const newChildId = details.id ?? /Id:\s*([0-9a-f-]{6,})/i.exec(String(e.output ?? ""))?.[1];
        if (!(row.state === "exited-without-done" || (row.state === "killed" && recovery.mayResume(row.recoveryCause))) || typeof newChildId !== "string" || !newChildId || newChildId === row.childId) {
          operation.acknowledgement.infraIssue = true;
          operation.acknowledgement.error = "resume acknowledgement lacks an eligible old row or a new child id";
          continue;
        }
        if (!receipts.lifecycle[newChildId]) {
          applyLifecycle(receipts, newChildId, "resumed", Date.now(), {
            name: details.name ?? row.name, agent: row.agent, purpose: row.purpose,
            taskIds: row.taskIds, askId: row.askId,
            sessionFile: details.sessionFile ?? args.sessionPath ?? row.sessionFile,
            attempt: (row.attempt ?? 1) + 1, resumedFrom: row.childId,
          });
        }
        row.resumedBy = newChildId;
      } else {
        applyLifecycle(receipts, row.childId, state, Date.now(), state === "exited-without-done"
          ? { resumeEligible: details.resumeEligible === true, completionKind: state } : {});
      }
      operation.effect = { phase: "effect", tool: e.tool, childId: row.childId, state, ts: e.ts ?? Date.now() };
    } else if (e.type === "notification" && e.kind === "subagent_result") {
      const payload = e.payload ?? {};
      if (payload.reconciliationError || payload.completionDecisionError || payload.infraIssue) {
        const childId = String(payload.id ?? payload.childId ?? "unknown");
        const operationId = `reconcile-mark:${childId}`;
        if (!receipts.operations[operationId]?.acknowledgement) {
          persistClaim(sessionFile, receipts, {v: 1, seq: 0, ts: e.ts ?? Date.now(), operationId,
            tool: "status_reconciliation", phase: "acknowledgement", childId, infraIssue: true,
            error: String(payload.reconciliationError ?? payload.completionDecisionError ?? "child reported infrastructure failure"),
            detail: {taskIds: payload.revertedTaskIds ?? payload.taskIds ?? []}}, errors);
          changed = true;
        }
      }
      if (!capabilities?.completionKind && !payload.completionKind) {
        receipts.operations["protocol:completion-kind"] ??= { acknowledgement: {
          phase: "acknowledgement", infraIssue: true,
          error: "completionKind capability missing: reload the extension before running this bridge",
        } };
        changed = true;
        continue;
      }
      const rows = Object.values(receipts.lifecycle);
      const childId = String(payload.id ?? payload.childId ?? "");
      const row = childId
        ? rows.find((r) => r.childId === childId)
        : payload.name
          ? rows.filter((r) => r.name === payload.name)
          : [];
      const target = Array.isArray(row) ? (row.length === 1 ? row[0] : undefined) : row;
      if (!target) continue;
      const completionIdentity = payload.resultStorePath ?? e.message?.eventId ?? e.eventId;
      if (!completionIdentity) continue;
      const completionId = `${target.childId}:${completionIdentity}`;
      if (receipts.consumedCompletions.includes(completionId)) continue;
      receipts.consumedCompletions.push(completionId);
      // Explicit completionKind from the parent's watcher/.exit facts. Legacy
      // notices without one are never task success: an unknown clean exit
      // folds as exited-without-done, never "completed".
      const reportedKind = payload.completionKind
        ?? ((payload.exitCode ?? 0) !== 0 || payload.errorMessage || payload.error ? "failed" : "exited-without-done");
      const kind = ["completed", "failed"].includes(reportedKind) ? reportedKind : "exited-without-done";
      applyLifecycle(receipts, target.childId, kind, Date.now(), {
        completionKind: kind, resumeEligible: kind === "exited-without-done",
        ...(payload.resultStorePath ? { resultStorePath: payload.resultStorePath } : {}),
        ...(payload.sessionFile ? { sessionFile: payload.sessionFile } : {}),
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
      Object.assign(receipts.lifecycle[target.childId], {
        report: report.slice(0, 4000), structured: payload.handoff?.structured,
        schemaViolated: payload.handoff?.schemaViolated === true || payload.schemaViolated === true,
        infraIssue: payload.infraIssue === true, reconciliationError: payload.reconciliationError,
      });
      changed = true;
    } else if (e.type === "tool_result" && ["task", "task_update"].includes(e.tool)) {
      // P5: a successful `task op:"complete"` resolves the reconciliation
      // mark(s) for that task — the auditable auto-complete effect.
      const call = calls.get(e.callId);
      const args = call?.args ?? {};
      const details = isRecord(e.details) ? e.details : {};
      const op = args.op ?? details.op;
      const completedId = Number(args.id ?? details.id);
      const binding = /^status-reconcile-complete:(.+):(\d+)$/.exec(args.operationId ?? "");
      const marks = statusReconciliation.pendingStatusReconciliations(receipts).filter((mark) =>
        binding ? mark.childId === binding[1] && mark.taskId === Number(binding[2])
          : op === "complete" && mark.taskId === completedId);
      for (const mark of marks) {
        const successful = acknowledged(e);
        persistClaim(sessionFile, receipts, {v: 1, seq: 0, ts: e.ts ?? Date.now(),
          operationId: `status-reconcile-complete:${mark.childId}:${mark.taskId}`, tool: e.tool,
          phase: "acknowledgement", childId: mark.childId,
          detail: {successful, ...(successful ? {} : {error: details.error ?? e.output})}}, errors);
        if (successful) reconcileMark(sessionFile, receipts, mark, "auto-completed",
          {ref: args.updates?.[0]?.ref ?? args.ref}, errors);
      }
    } else if (e.type === "tool_result") {
      const operation = Object.entries(receipts.operations).find(([key, row]) =>
        key.startsWith("escalation:") && row.intent?.callId === e.callId)?.[1];
      if (operation && !operation.acknowledgement) {
        operation.acknowledgement = { phase: "acknowledgement", isError: !acknowledged(e),
          ...(typeof e.details?.askId === "string" ? {detail: {askId: e.details.askId}} : {}) };
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Merge the durable receipts (folded from the full transcript on every build
 * pass) with the event fold and persist the merge. Corrupt or unwritable
 * ledgers surface as flags — the engine must escalate, never converge on an
 * empty ledger.
 */
export function mergedWorkers(sessionFile, events, capabilities) {
  const loaded = readOrchReceipts(sessionFile);
  const receipts = loaded.receipts;
  const ledger = { corrupt: loaded.corrupt === true, error: loaded.error, writeError: null, operationError: null, operationErrorIds: [], unresolved: [] };
  if (loaded.corrupt) return { rows: workerRows(receipts), ledger, receipts };
  if (Object.keys(receipts.lifecycle).length === 0) {
    try {
      const rows = JSON.parse(readFileSync(`${sessionFile}.workers.json`, "utf8"));
      migrateLegacyWorkers(receipts, rows);
    } catch {
      // No legacy ledger — a fresh one starts here.
    }
  }
  const writeErrors = [];
  foldEvents(receipts, events, capabilities, sessionFile, writeErrors);
  if (writeErrors.length) ledger.writeError = writeErrors.join("; ");
  const operations = Object.entries(receipts.operations);
  const unresolved = operations.filter(([, operation], index) => {
    if (operation.reconciled) return false;
    const ack = operation.acknowledgement?.infraIssue ? operation.acknowledgement : operation.intent;
    if (!ack?.infraIssue) return false;
    const childId = ack.childId ?? operation.intent?.childId;
    // Status-reconciliation faults reserve tasks, not the ask-routing machinery.
    if (operation.acknowledgement?.tool === 'status_reconciliation') return false;
    // Keep the failed receipt for audit, but a later acknowledged effect on
    // this same child reconciles the transient failure, even after reload.
    return !childId || !operations.some(([, later], laterIndex) => {
      const effect = later.effect;
      return effect?.childId === childId && later.acknowledgement &&
        !later.acknowledgement.isError && !later.acknowledgement.infraIssue &&
        ((effect.ts ?? 0) > (ack.ts ?? 0) || ((effect.ts ?? 0) === (ack.ts ?? 0) && laterIndex > index));
    });
  });
  if (unresolved.length) {
    ledger.operationErrorIds = unresolved.map(([id]) => id).sort();
    ledger.operationError = unresolved.map(([id, operation]) =>
      `${id}: ${operation.acknowledgement?.error ?? operation.intent?.error}`).join("; ");
  }
  ledger.unresolved = operations.filter(([, operation]) => operation.intent && !operation.acknowledgement && !operation.effect)
    .map(([id]) => id);
  ledger.unresolved.push(...Object.values(receipts.lifecycle)
    .filter((row) => row.state === "spawn_pending" && !row.spawnFailed).map((row) => row.childId));
  if (sessionFile) {
    const saved = saveOrchReceipts(sessionFile, receipts, capabilities?.completionKind ? ["protocol:completion-kind"] : []);
    if (saved.error) ledger.writeError = saved.error;
  }
  return { rows: workerRows(receipts), ledger, receipts };
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
    ask_id: row.askId ?? null,
    spawn_slot: row.spawnSlot ?? null,
    reconciliation_operation_id: row.reconciliationOperationId ?? null,
    cwd: row.cwd ?? null,
    structured: row.structured,
    schemaViolated: row.schemaViolated === true,
    infraIssue: row.infraIssue === true,
    task_ids: row.taskIds ?? [],
    resume_eligible: row.resumeEligible === true,
    resumed_from: row.resumedFrom ?? null,
    resumed_by: row.resumedBy ?? null,
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
      ask_id: w.askId ?? null,
      resume_eligible: w.resume_eligible,
      resumed_from: w.resumed_from,
      resumed_by: w.resumed_by,
      session_file: w.session_file,
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

function thinkerDispatched(events, askId) {
  return events.some((event) => event.type === "decision" && event.calls?.some((call) =>
    call.tool === "subagent" && (call.args?.askId === askId || (call.spawn?.slot ?? call.args?.spawnSlot) === `think:${askId}` || legacyThinkerAskId(call) === askId)));
}

function escalationSent(events, askId, receipts) {
  if (receipts?.operations[`escalation:${askId}`]?.acknowledgement?.isError === false) return true;
  // Corrupt/unwritable ledgers cannot persist receipts, so also check the
  // transcript. Intent alone (or a rejected acknowledgement) is never sent.
  return events.some((e) => e.type === "decision" && e.calls?.some((c) => {
    const matches = c?.tool === "escalate" ? String(c.args?.key ?? "") === askId
      : ["subagent_ask_parent", "subagent_done"].includes(c?.tool) &&
        String(c.args?.question ?? c.args?.result ?? "").includes(`escalation_for: ${askId}`);
    return matches && events.some((result) =>
      result.type === "tool_result" && result.callId === c.id && acknowledged(result));
  }));
}

function inboxKey(prefix, identity) {
  return `${prefix}-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
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

/** E2: a terminal thinker whose target ask is still pending. */
function unconsumedThinker(workers, asks) {
  for (const w of workers) {
    if (w.purpose !== "think" || w.running || (w.state === "spawn_pending" && !w.spawn_failed) || !w.askId) continue;
    const ask = asks.find((a) => a.askId === w.askId);
    if (ask) return { worker: w, ask };
  }
  return null;
}

/** B3: route an escalation upward by capability — root Inbox row, parent ask,
 *  or a terminal NOT-completed report the LLM parent must surface. A
 *  forwarded ask's answer auto-chains to the asking child without waking this
 *  session (the child's subagent_done converges the run). */
function escalateAction(req, { key, title, body, parentBody = body, markerAskId, forwardAskId = null, infrastructureIssue = false, decide }) {
  const marker = `escalation_for: ${markerAskId ?? key}`;
  if (req.tools.some((t) => t.name === "escalate")) {
    return {
      say: `Escalating to the user's Inbox: ${title}`,
      calls: [
        {
          tool: "escalate",
          args: {
            ...(infrastructureIssue ? {infrastructureIssue: true} : {update: true}),
            key,
            ...(decide ? {decide} : {}),
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
            question: `ESCALATION REQUEST (needs the user)${marker ? ` — ${marker}` : ""}: ${title}\n\n${parentBody}`,
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
            `Goal was NOT completed — this is an escalation request needing the user, not a completion report.\n\n` +
            (key.startsWith("lc-") ? `While the orchestration ledger is corrupt or unwritable, this subagent_done call will be REFUSED by the extension ` +
              `(fail closed); no completion can be recorded.\n\n` : "") + body,
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

function completionRows(req) {
  if (req.state?.completionDecisionError) return {error: req.state.completionDecisionError, rows: []};
  if (req.agent?.sessionFile) {
    try {
      if (completionDecisions.completionQuarantinedIds(req.agent.sessionFile).size) return {error: 'Quarantined completion actions require reconciliation', rows: []};
      const loaded = loadOrchReceipts(req.agent.sessionFile);
      if (!loaded.ok) return {error: loaded.error, rows: []};
      return {rows: orchestrationJournal.completionJournalState(loaded.receipts)};
    } catch (error) { return {error: String(error), rows: []}; }
  }
  return {rows: req.state?.completionDecisions ?? []};
}

/** The authoritative task snapshot: absent means the provider could not read one; ok:false is a store failure. */
function taskTreeOf(req) {
  const tree = req.state?.taskTree;
  if (tree === undefined) return {available: false};
  if (!isRecord(tree) || tree.ok !== true) return {available: true, ok: false, error: String(isRecord(tree) ? tree.error : "task snapshot unreadable")};
  return {available: true, ok: true, tree, byId: new Map((tree.tasks ?? []).map((task) => [task.id, task]))};
}

/**
 * P5 reconciliation view over the authoritative task tree: pending marks whose
 * task is still open are unresolved (scout or decision pending); marks whose
 * task is already closed resolve mechanically — a completed task needs no
 * status scout. Store failures are errors, never an empty surface.
 */
function reconciliationView(req, receipts, errors = []) {
  const treeInfo = taskTreeOf(req);
  const marks = [...new Map([...statusReconciliation.pendingStatusReconciliations(receipts),
    ...(req.state?.statusReconciliation?.unresolved ?? [])].filter((mark) =>
      !receipts.operations[mark.operationId]?.reconciled).map((mark) => [mark.operationId, mark])).values()];
  if (!treeInfo.available) return {available: false, unresolved: marks, resolved: []};
  if (!treeInfo.ok) return {available: true, storeError: treeInfo.error, unresolved: marks, resolved: []};
  const sessionFile = req.agent?.sessionFile;
  const resolved = [];
  const unresolved = [];
  const missing = [];
  for (const mark of marks) {
    const task = treeInfo.byId.get(mark.taskId);
    if (task && ["done", "replaced"].includes(task.status)) {
      reconcileMark(sessionFile, receipts, mark, `task already ${task.status}`, {}, errors);
      resolved.push(mark);
    } else if (task) unresolved.push({...mark, task});
    else {
      reconcileMark(sessionFile, receipts, mark, "missing-from-snapshot", {identity: scoutKey(mark)}, errors);
      persistClaim(sessionFile, receipts, {v: 1, seq: 0, ts: Date.now(), operationId: `reconcile-mark:${mark.childId}`,
        tool: "status_reconciliation", phase: "acknowledgement", childId: mark.childId, infraIssue: true,
        error: `Task #${mark.taskId} fell out of authoritative subtree visibility`, detail: {taskIds: [mark.taskId], identity: scoutKey(mark)}}, errors);
      missing.push(mark);
    }
  }
  return {available: true, ok: true, byId: treeInfo.byId, unresolved, resolved, missing,
    ...(errors.length ? {writeError: errors.join("; ")} : {})};
}

/** A read-only scout definition from the scoped roster; a writer never scouts by default. */
function scoutAgent(req) {
  const roster = Array.isArray(req.roster) ? req.roster : [];
  // Presentation rosters are capped; the materializer validates the full scoped roster.
  return roster.find((agent) => agent.name === "scout")?.name ?? "scout";
}

/** Completed status-scout verdicts bound to an unresolved mark (malformed verdicts included, flagged). */
export function scoutVerdicts(workers, reconciliation) {
  if (!reconciliation.available || reconciliation.storeError) return [];
  return workers.filter((w) => w.purpose === "status_scout" && w.completed).flatMap((worker) => {
    const mark = (reconciliation.unresolved ?? []).find((mark) =>
      worker.reconciliation_operation_id === mark.operationId || worker.spawn_slot === `status-scout:${mark.childId}:${mark.taskId}`);
    if (!mark) return [];
    let report = worker.structured;
    if (report === undefined && worker.report_path) {
      try { report = readFileSync(worker.report_path, "utf8"); } catch { /* unusable report */ }
    }
    const verdict = worker.schemaViolated || worker.infraIssue ? undefined : statusReconciliation.parseScoutStatusReport(report);
    return [{worker, mark, verdict}];
  });
}

/** One eligibility rule for classification and execution; missing revision/ownership fails closed. */
export function autoCompleteEligible(mark, verdict, scoutRef, ownerId) {
  return verdict?.status === "done" && mark.task?.status === "open" &&
    Number.isSafeInteger(mark.revision) && Number.isSafeInteger(mark.taskRevision) && Number.isSafeInteger(mark.task?.revision) &&
    mark.task.revision === mark.taskRevision && (!mark.task.assignedToId || mark.task.assignedToId === ownerId) &&
    typeof scoutRef === "string" && scoutRef.startsWith("/");
}

const scoutKey = (mark) => `sc:${mark.childId}:${mark.taskId}`;
const completionKey = (mark) => `status-reconcile-complete:${mark.childId}:${mark.taskId}`;
function consumedTaskUpdates(req, receipts) {
  const consumed = new Set(Object.values(receipts.operations).flatMap((op) =>
    typeof op.effect?.detail?.consumedDecisionId === "string" ? [op.effect.detail.consumedDecisionId] : []));
  return (req.state?.sessionMessages?.taskUpdates ?? []).filter((decision) => !consumed.has(decision.id));
}
function actionableVerdicts(req, workers, reconciliation, receipts) {
  return scoutVerdicts(workers, reconciliation).filter(({mark}) => !receipts.operations[mark.operationId]?.reconciled &&
    !escalationSent(req.events, inboxKey("sc", scoutKey(mark)), receipts));
}

/** Bounded scout concurrency: scouts in flight or spawning count against the cap. */
const SCOUT_CONCURRENCY = 2;

function outstandingScouts(workers) {
  return workers.filter((w) => w.purpose === "status_scout" &&
    (w.running || (w.state === "spawn_pending" && !w.spawn_failed)));
}

/** One status-scout dispatch per (child, task): the transcript marker and the ledger row both dedupe. */
function scoutDispatched(req, workers, mark) {
  const slot = `status-scout:${mark.childId}:${mark.taskId}`;
  return workers.some((w) => w.purpose === "status_scout" &&
    (w.reconciliation_operation_id === mark.operationId || w.spawn_slot === slot)) ||
    req.events.some((e) => e.type === "decision" && e.calls?.some((call) => call.tool === "subagent" &&
      (call.spawn?.slot ?? call.args?.spawnSlot) === slot));
}

/** The mechanical scout spawn: slot brief with verbatim task text, evidence pointers and the {status} contract — never `tasks` (the scout never acquires the task). */
export function scoutSpawnCall(req, mark) {
  return {say: `Dispatching a status scout for task #${mark.taskId}.`, calls: [{
    tool: "subagent", args: {agent: scoutAgent(req) ?? "scout", purpose: "status_scout"},
    spawn: {slot: `status-scout:${mark.childId}:${mark.taskId}`},
    reason: `status scout bound to ${mark.operationId}`,
  }]};
}

const liveWorker = (worker) => worker.running || (worker.state === "spawn_pending" && !worker.spawn_failed);
const ownRun = (req, task) => Boolean(req.agent?.id && task.assignedToId === req.agent.id && task.status === "in_progress");
const blocking = (req, task) => !ownRun(req, task) && !["done", "replaced"].includes(task.status);
const RESUME_RECONCILIATION = "Receipts reconciled; resume decisions";
function writerInWorktree(req, workers) {
  const cwd = resolve(req.agent?.cwd ?? process.cwd());
  // Legacy work rows without a cwd conservatively share our worktree: serialize, never risk two writers.
  return workers.some((worker) => liveWorker(worker) && (!worker.purpose || worker.purpose === "work") &&
    resolve(worker.cwd ?? cwd) === cwd);
}
function reservedTasks(req, receipts, exceptOperationId) {
  const reserved = new Set();
  const tree = taskTreeOf(req);
  for (const [id, operation] of Object.entries(receipts.operations)) {
    if (id === exceptOperationId) continue;
    const mark = operation.effect?.detail;
    const current = tree.available && tree.ok ? tree.byId.get(mark?.taskId) : undefined;
    // An explicit newer scope revision is a new authorization; an unanswered escalation is not.
    const escalated = operation.reconciled?.detail?.disposition === "escalated" &&
      (!Number.isSafeInteger(current?.revision) || !Number.isSafeInteger(mark?.taskRevision) || current.revision <= mark.taskRevision);
    if (id.startsWith("status-reconcile:") && mark?.status === "pending" && (!operation.reconciled || escalated)) reserved.add(mark.taskId);
    if (operation.acknowledgement?.infraIssue && !operation.reconciled)
      for (const taskId of operation.acknowledgement.detail?.taskIds ?? []) reserved.add(taskId);
  }
  return reserved;
}
/** Status faults hold work/convergence, but asks keep routing. A linked parent
 * answer, key-bound durable Inbox decision, or newer revision of every reserved
 * task releases the hold. An Inbox dismiss alone is never authorization. */
function statusFaultHolds(req, receipts, errors) {
  const tree = taskTreeOf(req);
  const holds = [];
  for (const [operationId, operation] of Object.entries(receipts.operations)) {
    const ack = operation.acknowledgement;
    if (ack?.tool !== "status_reconciliation" || !ack.infraIssue || operation.reconciled) continue;
    const key = inboxKey("lo", operationId);
    const ids = ack.detail?.taskIds ?? [];
    if (!operation.intent && tree.available && tree.ok) {
      persistClaim(req.agent?.sessionFile, receipts, {v: 1, seq: 0, ts: Date.now(), operationId,
        tool: "status_reconciliation", phase: "intent", detail: {
          taskRevisions: Object.fromEntries(ids.map((id) => [id, tree.byId.get(id)?.revision ?? null])),
        }}, errors);
    }
    const baseline = receipts.operations[operationId]?.intent?.detail?.taskRevisions;
    const revised = ids.length > 0 && baseline && tree.available && tree.ok && ids.every((id) => {
      const revision = tree.byId.get(id)?.revision;
      return Number.isSafeInteger(revision) && (baseline[id] === null || revision > baseline[id]);
    });
    const escalation = receipts.operations[`escalation:${key}`];
    const askId = escalation?.acknowledgement?.detail?.askId;
    const answered = req.events.some((event) => event.type === "notification" && event.kind === "answer" &&
      (event.source === "subagent_parent_answer" || event.message?.source === "parent-inbox") &&
      [key, askId].filter(Boolean).includes(event.payload?.askId ?? event.message?.askId));
    const inboxAnswered = escalation?.acknowledgement && !escalation.acknowledgement.isError &&
      req.state?.inboxDecisions?.some((item) => item.id === `infra-${key}` &&
        item.decision?.choice === RESUME_RECONCILIATION && item.decision.other === false);
    if (answered || inboxAnswered || revised) {
      persistClaim(req.agent?.sessionFile, receipts, {v: 1, seq: 0, ts: Date.now(), operationId,
        tool: "status_reconciliation", phase: "reconciled", childId: ack.childId,
        detail: {disposition: answered ? "parent-answered" : inboxAnswered ? "inbox-decided" : "reserved-tasks-revised", key}}, errors);
    }
    if (!receipts.operations[operationId]?.reconciled) holds.push({operationId, key, error: ack.error});
  }
  return holds;
}

/** A tasks-assigned jev may delegate its own run through the provider's slot.
 * Closed descendants travel as evidence refs; never redo reserved/blocked work. */
function defaultWorkCall(req, agentType, workers, receipts) {
  const tree = taskTreeOf(req);
  if (tree.available && (!tree.ok || tree.tree.tasks.some((task) => blocking(req, task)))) return null;
  const slot = req.spawnContexts?.find((slot) => slot.id === "default-work");
  if (!slot || writerInWorktree(req, workers) || (slot.taskIds ?? []).some((id) => reservedTasks(req, receipts).has(id))) return null;
  return {say: "Delegating the assigned run through the provider's default-work slot.", calls: [{
    tool: "subagent", args: {agent: agentType, purpose: "work"}, spawn: {slot: slot.id},
    reason: "provider-owned assigned-run dispatch",
  }]};
}

/** With no live child there is no wake source: request one keyed disposition,
 * rather than silently holding on blocked/foreign/reserved task state. */
function taskDispatchHold(req, tree, workers, receipts) {
  const tasks = tree.ok ? tree.tree.tasks.filter((task) => blocking(req, task) || reservedTasks(req, receipts).has(task.id)) : [];
  const say = "Holding: authorized tasks are reserved, owned or not open; never redo the goal prose.";
  if (workers.some(liveWorker)) return {say, calls: []};
  const key = inboxKey("tt", tasks.map((task) => task.id).sort((a, b) => a - b).join(",") || "no-eligible-dispatch");
  if (escalationSent(req.events, key, receipts)) return {say: `${say} Task-disposition escalation already sent.`, calls: []};
  return escalateAction(req, {key, title: "Authorized tasks have no eligible dispatch",
    body: `Goal was NOT completed. Authoritative tasks require disposition: ${tasks.map((task) => `#${task.id} (${task.status})`).join(", ") || "no eligible provider slot for the assigned run"}. No live child can advance this hold. Fix task state or supply the missing provider slot, then answer; an answer alone does not repair task state.`});
}

/** All three worker paths share task authority, reconciliation reservation and one-writer admission. */
export function dispatchEligible(req, task, workers, receipts, exceptOperationId) {
  const tree = taskTreeOf(req);
  return Boolean(tree.available && tree.ok && task && tree.byId.has(task.id) && task.status === "open" &&
    (!task.assignedToId || task.assignedToId === req.agent?.id) &&
    !reservedTasks(req, receipts, exceptOperationId).has(task.id) && !writerInWorktree(req, workers) &&
    !workers.some((worker) => liveWorker(worker) && worker.task_ids?.includes(task.id)));
}

/** Select an authoritative provider slot; the bridge never assembles a task brief. */
export function taskDispatchCall(req, task, agentType, reason, context, exceptOperationId) {
  const {rows: workers, receipts} = context ?? mergedWorkers(req.agent?.sessionFile, req.events, req.capabilities);
  if (!dispatchEligible(req, task, workers, receipts, exceptOperationId)) return null;
  return {say: `Dispatching a worker arm for task #${task.id}.`,
    calls: [{tool: "subagent", args: {agent: agentType, purpose: "work"}, spawn: {slot: `task:${task.id}`}, reason}]};
}

export function buildRequestCore(req) {
  const goal = resolveGoal(req.events);
  const { rows: workers, ledger, receipts } = mergedWorkers(req.agent?.sessionFile, req.events, req.capabilities);
  const asks = pendingAsks(req.events);
  const carriers = goalForState(goal, req.agent?.sessionFile);
  const doneCalled = doneAlreadyCalled(req.events);
  const agentQuestion = workerAgentQuestion(req);
  const targetQuestion = checkInTargetQuestion(workers);
  const completion = completionRows(req).rows.find((row) => row.status === 'offered' && completionDecisions.isPendingCompletion(row));
  // P5: reconciliation over the authoritative task tree, and the P4 join —
  // committed task-update decisions surface as finite options.
  const reconciliation = reconciliationView(req, receipts);
  const taskUpdateDecision = consumedTaskUpdates(req, receipts)[0];
  const scoutVerdict = actionableVerdicts(req, workers, reconciliation, receipts)
    .find(({mark, verdict, worker}) => verdict !== undefined &&
      !autoCompleteEligible(mark, verdict, worker.report_path, req.agent?.id));
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
      completion_decisions: completionRows(req),
      task_tree: req.state?.taskTree ?? null,
      pending_reconciliations: reconciliation.available
        ? (reconciliation.storeError
          ? {store_error: reconciliation.storeError}
          : reconciliation.unresolved.map((mark) => ({child_id: mark.childId, task_id: mark.taskId,
            revision: mark.revision, task_status: mark.task?.status ?? null, task_text: mark.task?.text ?? null, report_path: mark.reportPath ?? null})))
        : {unavailable: true, unresolved: reconciliation.unresolved},
      recent_events: digestEvents(req.events),
      run_state: req.state ?? null,
      // A corrupt or unwritable ledger blocks convergence (never a silent
      // empty-ledger fallback): mapAnswers refuses done and escalates.
      ...(ledger.corrupt ? { ledger_corrupt: true, ledger_error: ledger.error } : {}),
      ...(!ledger.corrupt && ledger.writeError ? { ledger_write_error: ledger.writeError } : {}),
      ...(ledger.operationError ? { ledger_operation_error: ledger.operationError } : {}),
      ...(ledger.unresolved.length ? { unresolved_operations: ledger.unresolved } : {}),
    },
    questions: {
      ...(completion ? {completion_decision: {type: 'choice', instructions: 'Choose exactly one offered completion or engine-recovery option. Recovery eligibility, mandatory teardown, thinker interrupt approval and resume caps are engine guards, not classifier judgement. Approval authorizes only the admitted sequential actions; human approval is a separate ask action.',
        criteria: Object.fromEntries(completion.offer.decisions.map((option) => [option.id, option.description]))}} : {}),
      // P4 join: a committed parent task-update decision (escalate always appended by the adapter).
      ...(taskUpdateDecision ? {task_update_decision: {type: 'choice',
        instructions: `A committed parent task-update (revision ${taskUpdateDecision.revision}) needs reconciliation. Choose exactly one offered option; escalation is always available.`,
        criteria: Object.fromEntries(taskUpdateDecision.options.map((option) => [option.id, option.description]))}} : {}),
      // P5: a non-done status-scout verdict routes a finite decision; `done` auto-completes mechanically.
      ...(scoutVerdict ? {task_reconciliation: {type: 'choice',
        instructions: `Status scout for task #${scoutVerdict.mark.taskId} ("${scoutVerdict.mark.task.text.slice(0, 80)}") reports "${scoutVerdict.verdict.status}". Choose exactly one reconciliation; escalate is always available.`,
        criteria: {
          redispatch_task: `Spawn a worker arm for task #${scoutVerdict.mark.taskId}: tasks:[id], stream, explicit cwd and slot brief.`,
          escalate: "Escalate the scout verdict for parent/user reconciliation.",
        }}} : {}),
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

/**
 * One converged result from every completed worker's report.
 * @deprecated P7 replaced terminal convergence with the shared convergence
 * state machine; this legacy concat-and-slice path survives only for the v6
 * compatibility sessions (pre-P7 offline fixtures) and must never be reached
 * on a P7 success path (spec §5).
 */
export function convergeReport(workers, done, next) {
  const completed = workers.filter((w) => w.completed && w.report);
  if (completed.length === 0) {
    return `Goal was NOT completed: no worker reports were received (jev: done=${done.toFixed(2)}, next=${next}).`;
  }
  return completed
    .map(
      (w) =>
        `Worker "${w.name}" (agent ${w.agent ?? "?"}, verdict ${w.verdict ?? "unknown"}):\n${w.report.trim()}`,
    )
    .join("\n\n---\n\n")
    .slice(0, 4000);
}

function completedResume(workers, worker, seen = new Set()) {
  if (!worker.resumed_by || seen.has(worker.child_id)) return false;
  seen.add(worker.child_id);
  const next = workers.find((w) => w.child_id === worker.resumed_by && w.resumed_from === worker.child_id);
  return Boolean(next && (next.completed || completedResume(workers, next, seen)));
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

export function mapAnswersCore(answers, req, p7 = {active: false}) {
  // The report was already delivered — never call subagent_done twice.
  if (doneAlreadyCalled(req.events)) {
    return { terminal: true, say: "Already reported done; ending.", calls: [] };
  }
  const done = answers.done?.noul ?? 0;
  const next = answers.next_action?.choice ?? "other";
  const agentType =
    answers.worker_agent?.choice && answers.worker_agent.choice !== "other"
      ? answers.worker_agent.choice
      : "worker";
  const goal = resolveGoal(req.events);
  const { rows: workers, ledger, receipts } = mergedWorkers(req.agent?.sessionFile, req.events, req.capabilities);
  const asks = pendingAsks(req.events);
  const blockers = workers.filter((w) => w.spawn_failed);
  // Leaf sessions (PI_DENY_TOOLS) have no spawn tools; emitting them faults every repair attempt.
  const canSpawn = req.tools.some((t) => t.name === "subagent");
  const canAnswerChild = req.tools.some((t) => t.name === "subagent_answer_child");

  // Corrupt or unwritable ledger: convergence may never succeed on an
  // unfaithful picture — stop and infra-escalate instead.
  if (ledger.corrupt || ledger.writeError || ledger.operationError) {
    const problem = ledger.corrupt
      ? `orchestration ledger corrupt: ${ledger.error}`
      : ledger.writeError
        ? `orchestration ledger write failed: ${ledger.writeError}`
        : `orchestration control unresolved: ${ledger.operationError}`;
    const key = ledger.corrupt || ledger.writeError
      ? inboxKey("lc", problem)
      : inboxKey(ledger.operationErrorIds.every((id) => id.startsWith("protocol:"))
        ? "pck" : "lo", [...ledger.operationErrorIds].sort().join(","));
    if (escalationSent(req.events, key, receipts)) {
      return { say: "Ledger escalation already sent; waiting for reconciliation.", calls: [] };
    }
    return escalateAction(req, {
      key, infrastructureIssue: true,
      title: "Decision orchestrator cannot trust its worker ledger",
      body:
        `${problem}. The run cannot record success on an untrusted ledger — worker lifecycle state cannot be proven, ` +
        `so no convergence or task completion may be recorded. This escalation request needs the user.`,
    });
  }

  // Fold snapshot dispositions before constructing holds, including missing-task faults.
  const reconciliation = reconciliationView(req, receipts);
  const statusErrors = reconciliation.writeError ? [reconciliation.writeError] : [];
  const statusHolds = statusFaultHolds(req, receipts, statusErrors);
  if (statusErrors.length) {
    const problem = statusErrors.join("; ");
    const key = inboxKey("lc", problem);
    if (escalationSent(req.events, key, receipts)) return {say: "Reconciliation journal write failed; waiting for recovery.", calls: []};
    return escalateAction(req, {key, infrastructureIssue: true, title: "Reconciliation journal write failed", body: `NOT completed. ${problem}`});
  }
  // A new bridge under an older loaded extension must not silently lose the
  // durable Inbox recovery projection (or run with the pre-pair task CAS).
  if (!Array.isArray(req.state?.inboxDecisions) &&
      (req.state?.taskTree?.tasks?.length || reconciliation.unresolved?.length || statusHolds.length)) {
    const key = "pair-p5";
    if (escalationSent(req.events, key, receipts)) return {say: "P5 pairing escalation already sent; reload the paired extension and bridge.", calls: []};
    return escalateAction(req, {key, infrastructureIssue: true, title: "P5 extension/bridge pair required",
      body: "NOT completed. jev-bridge v5 requires the paired extension's expectedTaskRevision task-bound completion CAS and state.inboxDecisions projection. Reload both together before resuming P5 decisions."});
  }
  // Re-upsert the SAME key after dismissal or any non-resuming answer.
  // The production upsert clears its ack/decision; the next full-session
  // projection then stops reopening it. Only explicit RESUME authorizes release.
  const unsentHold = statusHolds.find((hold) => !escalationSent(req.events, hold.key, receipts) ||
    (req.tools.some((tool) => tool.name === "escalate") && req.state?.inboxDecisions?.some((item) =>
      item.id === `infra-${hold.key}` && item.ackedTs !== undefined &&
      !(item.decision?.choice === RESUME_RECONCILIATION && item.decision.other === false))));
  if (unsentHold) {
    const problem = `NOT completed. ${unsentHold.operationId}: ${unsentHold.error}. Reserved tasks cannot dispatch and convergence is held. `;
    return escalateAction(req, {key: unsentHold.key, infrastructureIssue: true,
      title: "Task reconciliation needs recovery",
      body: problem + `After checking the task receipts, choose "${RESUME_RECONCILIATION}" in the Inbox decision (not dismiss), ` +
        `or revise every reserved task to authorize new work. Dismissal or a non-resuming answer (including Other) reopens this same row on the next decision, including after reload. This releases decisions, not task completion.`,
      parentBody: problem + "After checking the task receipts, answer this linked subagent_ask_parent request directly, or revise every reserved task to authorize new work. Forwarding it into your own Inbox does not answer this ask. This releases decisions, not task completion.",
      decide: {question: "Have the authoritative task receipts been reconciled?", options: [RESUME_RECONCILIATION]}});
  }

  const completions = completionRows(req);
  if (completions.error) {
    const key = inboxKey('cd', completions.error);
    if (escalationSent(req.events, key, receipts)) return {say: 'Completion escalation already sent; waiting for reconciliation.', calls: []};
    return escalateAction(req, {infrastructureIssue: true, key, title: 'Completion journal unavailable', body: `NOT completed. Reconcile the completion journal: ${completions.error}`});
  }
  const pending = completions.rows.find(completionDecisions.isPendingCompletion);
  if (pending) {
    if (pending.status !== 'offered') return {say: 'Completion actions/parent answer pending; NOT completed.', calls: []};
    if (!Object.hasOwn(answers, 'completion_decision')) return {say: 'Completion offer arrived during classification; waiting for its notice.', calls: []};
    if (!req.tools.some((tool) => tool.name === 'apply_decision')) return escalateAction(req, {key: inboxKey('cd', pending.offer.completionId), title: 'Completion executor unavailable', body: `NOT completed. Reload with apply_decision. Report: ${pending.offer.reportRef}`});
    const offer = pending.offer;
    const choice = answers.completion_decision?.choice;
    const optionId = offer.decisions.some((option) => option.id === choice) ? choice : '__escalate';
    return {calls: [{tool: 'apply_decision', args: {completionId: offer.completionId, snapshotRevision: offer.snapshotRevision,
      offerHash: offer.offerHash, reportRef: offer.reportRef, optionId}, reason: 'finite completion option selected'}]};
  }

  // P4 join: a committed parent task-update decision offers finite options with
  // escalate always appended. Selection executes its one typed action; nothing
  // here re-mutates the committed batch. Even during a status-fault hold,
  // explicit parent task-update decisions may dispatch non-reserved tasks.
  const taskUpdateDecision = consumedTaskUpdates(req, receipts)[0];
  let decisionHold = statusHolds.length > 0;
  const consumeUpdate = (disposition) => {
    const errors = [];
    persistClaim(req.agent?.sessionFile, receipts, {v: 1, seq: 0, ts: Date.now(),
      operationId: `task-update-consumed:${taskUpdateDecision.id}`, tool: "task_update_decision", phase: "effect",
      detail: {consumedDecisionId: taskUpdateDecision.id, operationId: taskUpdateDecision.operationId, disposition}}, errors);
    if (errors.length) ledger.writeError = errors.join("; ");
    return !errors.length;
  };
  if (taskUpdateDecision) {
    const updateKey = inboxKey("tu", taskUpdateDecision.id);
    if (!Object.hasOwn(answers, "task_update_decision")) {
      return {say: "Task-update decision arrived during classification; waiting for its notice.", calls: []};
    }
    const chosen = taskUpdateDecision.options.find((option) => option.id === answers.task_update_decision?.choice);
    if (!chosen || chosen.id === "__escalate__") {
      consumeUpdate("escalated");
      if (!escalationSent(req.events, updateKey, receipts)) return escalateAction(req, {key: updateKey,
        ...(ledger.writeError ? {infrastructureIssue: true} : {}), title: "Task update needs reconciliation",
        body: `Committed task update ${taskUpdateDecision.operationId} (revision ${taskUpdateDecision.revision}) needs judgement:\n${taskUpdateDecision.correction}`});
      decisionHold = true;
    }
    for (const action of chosen?.actions ?? []) {
      if (action.type === "task.update") {
        if (!req.tools.some((tool) => tool.name === "task_update")) {
          return escalateAction(req, {key: updateKey, infrastructureIssue: true, title: "Task update executor unavailable",
            body: `NOT reconciled. Reload with task_update. Decision ${taskUpdateDecision.id}, revision ${taskUpdateDecision.revision}.`});
        }
        return {say: `Applying the revision-bound task update (${taskUpdateDecision.operationId}).`,
          calls: [{tool: "task_update", args: action.input, reason: "executed the committed task-update decision"}]};
      }
      if (action.type === "task.dispatch") {
        const treeInfo = taskTreeOf(req);
        if (!treeInfo.available || !treeInfo.ok) {
          decisionHold = true;
          if (!escalationSent(req.events, updateKey, receipts)) return escalateAction(req, {key: updateKey, infrastructureIssue: true,
            title: "Task snapshot unavailable for dispatch", body: `NOT completed. Cannot resolve ${taskUpdateDecision.id} without an authoritative task snapshot.`});
          break;
        }
        if (treeInfo.available && treeInfo.ok) {
          for (const taskId of action.taskIds ?? []) {
            const dispatch = taskDispatchCall(req, treeInfo.byId.get(taskId), agentType,
              "dispatch the committed task update to a worker arm", {rows: workers, receipts});
            if (dispatch && consumeUpdate("dispatch-selected")) return dispatch;
          }
        }
        // A scope update to live/owned/reserved work is a resolved no-op, not a failed dispatch.
        consumeUpdate("no-dispatch-eligible");
        break;
      }
    }
    if (!chosen?.actions?.some((action) => ["task.update", "task.dispatch"].includes(action.type))) decisionHold = true;
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

  // P5: authoritative task reconciliation. The task tree drives everything:
  // store failures are errors (never an empty success); already-closed tasks
  // resolve mechanically; a completed child's open task gets ONE status scout
  // (bounded concurrency); exited/killed orphans stay with lifecycle recovery.
  if (!reconciliation.available && reconciliation.unresolved.length) {
    const key = inboxKey("ts", "task snapshot unavailable");
    if (!escalationSent(req.events, key, receipts)) return escalateAction(req, {key, infrastructureIssue: true,
      title: "Task snapshot unavailable for reconciliation", body: `NOT completed. Pending marks cannot be reconciled without the authoritative task tree: ${reconciliation.unresolved.map(scoutKey).join(", ")}`});
    decisionHold = true;
  }
  if (reconciliation.available && reconciliation.storeError) {
    const key = inboxKey("ts", reconciliation.storeError);
    if (!escalationSent(req.events, key, receipts)) {
      return escalateAction(req, {key, infrastructureIssue: true, title: "Task store unavailable for reconciliation",
        body: `NOT reconciled. The authoritative task snapshot failed: ${reconciliation.storeError}. No scout or dispatch may run on an unreadable tree.`});
    }
    return {say: "Task-store escalation already sent; waiting for reconciliation.", calls: []};
  }
  if (reconciliation.available && !statusHolds.length) {
    const verdicts = actionableVerdicts(req, workers, reconciliation, receipts);
    const malformed = verdicts.find(({verdict}) => verdict === undefined);
    if (malformed) {
      const identity = scoutKey(malformed.mark);
      const key = inboxKey("sc", identity);
      if (!escalationSent(req.events, key, receipts)) {
        const errors = [];
        reconcileMark(req.agent?.sessionFile, receipts, malformed.mark, "escalated", {identity}, errors);
        if (errors.length) ledger.writeError = errors.join("; ");
        return escalateAction(req, {key, infrastructureIssue: true, title: "Status scout report is unusable",
          body: `${identity}: NOT reconciled. Scout ${malformed.worker.child_id} returned no strict {"status"} verdict for task #${malformed.mark.taskId}. Malformed, flagged and stale scout results are never success. Report: ${malformed.worker.report_path ?? "(none)"}`});
      }
    }
    const verdict = verdicts.find(({mark, verdict, worker}) => verdict !== undefined &&
      autoCompleteEligible(mark, verdict, worker.report_path, req.agent?.id)) ??
      verdicts.find(({verdict}) => verdict !== undefined);
    if (verdict) {
      const {worker, mark} = verdict;
      const status = verdict.verdict.status;
      const scoutRef = worker.report_path ?? undefined;
      // `done` auto-completes only after the recheck: status still open, the
      // task revision unchanged since the mark, and an evidence ref present.
      // `replaced` alone can never bypass replacement-chain validation.
      const failedAttempt = receipts.operations[completionKey(mark)]?.acknowledgement?.detail?.successful === false;
      const eligible = autoCompleteEligible(mark, verdict.verdict, scoutRef, req.agent?.id) && !failedAttempt;
      if (eligible) {
        if (!req.tools.some((tool) => tool.name === "task_update")) {
          const identity = scoutKey(mark);
          const key = inboxKey("sc", identity);
          if (!escalationSent(req.events, key, receipts)) return escalateAction(req, {key, infrastructureIssue: true,
            title: "Task service unavailable for auto-completion",
            body: `${identity}: NOT reconciled. Reload with task_update to complete task #${mark.taskId}. Scout report: ${scoutRef}`});
          decisionHold = true;
        } else {
        return {
          say: `Status scout confirmed task #${mark.taskId} done; completing it with the scout report as the evidence ref.`,
          calls: [{
            tool: "task_update",
            args: {operationId: completionKey(mark), expectedRevision: req.state.taskTree.revision,
              updates: [{id: mark.taskId, expectedTaskRevision: mark.taskRevision, complete: true, ref: scoutRef}], message: "Status scout confirmed task completion"},
            reason: "scout done verdict auto-completes the task through the shared task service",
          }],
        };
        }
      }
      if (!eligible && !failedAttempt && !Object.hasOwn(answers, "task_reconciliation")) {
        return {say: "Status scout verdict arrived during classification; waiting for its notice.", calls: []};
      }
      if (answers.task_reconciliation?.choice === "redispatch_task") {
        const agentType = answers.worker_agent?.choice && answers.worker_agent.choice !== "other"
          ? answers.worker_agent.choice : "worker";
        const dispatch = taskDispatchCall(req, mark.task, agentType,
          `status scout verdict "${status}" routed to a worker arm`, {rows: workers, receipts}, mark.operationId);
        if (dispatch) {
          const errors = [];
          if (reconcileMark(req.agent?.sessionFile, receipts, mark, "redispatched", {}, errors)) return dispatch;
          ledger.writeError = errors.join("; ");
        }
      }
      const identity = scoutKey(mark);
      const key = inboxKey("sc", identity);
      const errors = [];
      reconcileMark(req.agent?.sessionFile, receipts, mark, "escalated", {identity, failedAttempt}, errors);
      if (errors.length) ledger.writeError = errors.join("; ");
      if (!escalationSent(req.events, key, receipts)) return escalateAction(req, {key,
        ...(failedAttempt || ledger.writeError ? {infrastructureIssue: true} : {}), title: `Task #${mark.taskId} reconciliation needs judgement`,
        body: `${identity}: ${failedAttempt ? "Auto-completion was refused; no automatic retry. " : ""}Status scout verdict: ${JSON.stringify(verdict.verdict)}. Task #${mark.taskId} ("${mark.task.text}") is "${mark.task.status}"` +
          `${mark.task.revision !== undefined ? ` at revision ${mark.task.revision}` : ""}` +
          `${mark.taskRevision !== undefined ? ` (marked at task revision ${mark.taskRevision})` : ""}. ` +
          `Scout report: ${worker.report_path ?? "(none)"}. Original child: ${mark.childId}.`});
      decisionHold = true;
    }
    // A terminal scout is never a permanent in-flight reservation or an implicit pass.
    for (const mark of reconciliation.unresolved) {
      if (receipts.operations[mark.operationId]?.reconciled) continue;
      const failed = workers.find((worker) => worker.purpose === "status_scout" && !liveWorker(worker) && !worker.completed &&
        (worker.reconciliation_operation_id === mark.operationId || worker.spawn_slot === `status-scout:${mark.childId}:${mark.taskId}`));
      if (!failed) continue;
      const identity = scoutKey(mark), key = inboxKey("sc", identity), errors = [];
      reconcileMark(req.agent?.sessionFile, receipts, mark, "escalated", {identity, failedScout: failed.child_id ?? failed.spawn_slot}, errors);
      if (errors.length) ledger.writeError = errors.join("; ");
      if (!escalationSent(req.events, key, receipts)) return escalateAction(req, {key, infrastructureIssue: true,
        title: "Status scout ended without a usable result", body: `${identity}: Goal was NOT completed. Scout ended in ${failed.state}${failed.spawn_failed ? " (spawn failed)" : ""}.`});
    }
    const orphans = reconciliation.unresolved.filter((mark) => !receipts.operations[mark.operationId]?.reconciled &&
      (!receipts.lifecycle[mark.childId] || ["failed", "killed", "exited-without-done"].includes(receipts.lifecycle[mark.childId].state)));
    if (orphans.length) {
      const key = inboxKey("wi", [...new Set(orphans.map((mark) => mark.childId))].sort().join(","));
      const errors = [];
      for (const mark of orphans) reconcileMark(req.agent?.sessionFile, receipts, mark, "escalated", {orphan: true}, errors);
      if (errors.length) ledger.writeError = errors.join("; ");
      if (!escalationSent(req.events, key, receipts)) return escalateAction(req, {key,
        ...(ledger.writeError ? {infrastructureIssue: true} : {}), title: "Worker outcomes do not establish goal completion", body: `Goal was NOT completed. Reconcile or recover orphan workers: ${orphans.map((mark) => mark.childId).join(", ")}.`});
      decisionHold = true;
    }
    // Dispatch scouts mechanically for unresolved completed-child claims.
    const inFlight = outstandingScouts(workers).length;
    for (const mark of reconciliation.unresolved) {
      if (inFlight >= SCOUT_CONCURRENCY) break;
      if (receipts.operations[mark.operationId]?.reconciled || scoutDispatched(req, workers, mark)) continue;
      // Admission failures are emitted by the materializer, not as phantom scout spawns.
      if (escalationSent(req.events, inboxKey("sc", scoutKey(mark)), receipts)) {
        const errors = [];
        reconcileMark(req.agent?.sessionFile, receipts, mark, "escalated", {identity: scoutKey(mark), spawnAdmissionFailed: true}, errors);
        if (errors.length) ledger.writeError = errors.join("; ");
        continue;
      }
      const row = receipts.lifecycle[mark.childId];
      if (!row || row.state !== "completed") continue; // exited/killed orphans route through lifecycle recovery (P6)
      const spawn = scoutSpawnCall(req, mark);
      if (spawn) return spawn;
    }
  }

  if (ledger.writeError) {
    const key = inboxKey("lc", ledger.writeError);
    if (!escalationSent(req.events, key, receipts)) return escalateAction(req, {key, infrastructureIssue: true,
      title: "Reconciliation journal write failed", body: `NOT completed. ${ledger.writeError}`});
    decisionHold = true;
  }

  // E2: route a completed thinker's report — answer the asking child, or
  // escalate its finding upward (unparsable is an escalation, never a re-think).
  const thinker = unconsumedThinker(workers, asks);
  if (thinker) {
    const parsed = thinker.worker.completed ? parseThinkerReport(thinker.worker.report) : null;
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
    if (escalationSent(req.events, thinker.ask.askId, receipts)) {
      return { say: "Thinker escalation already sent; waiting for the user.", calls: [] };
    }
    const finding =
      !thinker.worker.completed
        ? `The thinker ended in state ${thinker.worker.state} without completing the ask. Reconcile or choose a new attempt; no automatic re-think will be dispatched.`
        : parsed?.kind === "escalation_request"
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
    if (thinkerDispatched(req.events, ask.askId) || workers.some((w) => w.purpose === "think" && w.askId === ask.askId)) {
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
            purpose: "think", askId: ask.askId,
            thinking: "medium",
            model: "fireworks-300k/fireworks:accounts/fireworks/models/glm-5p3",
            task,
            cwd: req.agent?.cwd ?? process.cwd(),
          },
          spawn: {slot: req.spawnContexts?.find((slot) => slot.purpose === "think" && slot.askId === ask.askId)?.id ?? `think:${ask.askId}`},
          reason: "pending ask routed to the thinker once",
        },
      ],
    };
  }

  // B3: pending asks and dead-end blockers reach the user by capability.
  if (next === "escalate" && (asks.length > 0 || blockers.length > 0)) {
    const ask = asks[0];
    // One escalation per ask: a re-chosen escalate idles until answered.
    if (ask && escalationSent(req.events, ask.askId, receipts)) {
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

  if (decisionHold && (done >= 0.5 || ["report_done", "spawn_worker"].includes(next))) return {say: "Holding: decision reconciliation pending.", calls: []};

  if ((done >= 0.5 || next === "report_done") && ledger.unresolved.length) {
    // P7: a reserved/awaiting-ack convergence arm is tracked by the convergence
    // journal ('wait'), not by this v6 unresolved-operations escalation.
    const armPending = (id) => {
      const row = receipts.lifecycle[id] ?? receipts.lifecycle[receipts.operations[id]?.intent?.childKey];
      return Boolean(p7.active && row && ARM_SLOT.test(row.spawnSlot ?? ""));
    };
    const unresolved = [...new Set(ledger.unresolved)].filter((id) => !armPending(id)).sort();
    if (unresolved.length) {
    const hold = { say: `Holding: unresolved operations ${unresolved.join(", ")} need reconciliation.`, calls: [] };
    // The provider commits terminal state BEFORE executing the tool call, so
    // escalateAction's refused-subagent_done fallback would latch the engine
    // finished before acknowledgement. Without an escalation capability, hold
    // until reconciliation instead.
    if (!req.tools.some((t) => t.name === "escalate" || t.name === "subagent_ask_parent")) {
      return hold;
    }
    const key = inboxKey("uo", unresolved.join(","));
    if (escalationSent(req.events, key, receipts)) return hold;
    return escalateAction(req, {
      key, title: "Orchestration operations need reconciliation",
      body: `Goal completion is blocked by unresolved operations: ${unresolved.join(", ")}. Reconcile their outcomes before proceeding.`,
    });
    }
  }

  // A4: a zero-worker turn must never exit as done while spawning is possible —
  // truncation can hide the real state, so verify mechanically instead.
  // P7 replaces the verify+repair worker with an independent convergence arm.
  if ((done >= 0.5 || next === "report_done") && workers.length === 0 && canSpawn) {
    if (p7.active) return p7HeldConvergence(req, answers, p7);
    const tree = taskTreeOf(req);
    const eligibleTask = tree.available && tree.ok ? tree.tree.tasks.find((task) => dispatchEligible(req, task, workers, receipts)) : undefined;
    if (eligibleTask) return taskDispatchCall(req, eligibleTask, agentType, "task-driven zero-worker guard", {rows: workers, receipts});
    const assignedRun = defaultWorkCall(req, agentType, workers, receipts);
    if (assignedRun) return assignedRun;
    if (tree.available && (!tree.ok || tree.tree.tasks.length > 0)) {
      return taskDispatchHold(req, tree, workers, receipts);
    }
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
    // P7: terminal convergence belongs to the convergence state machine —
    // a classifier verdict can never authorize successful done (spec §5).
    if (p7.active) return p7HeldConvergence(req, answers, p7);
    // No successful convergence with unresolved operations: a live child
    // (running, interrupted-but-live, or resumed) blocks the done report.
    const live = workers.filter((w) => w.running);
    if (live.length > 0) {
      return {
        say: `Holding: ${live.map((w) => `"${w.name}" (${w.state})`).join(", ")} still live — waiting for their results.`,
        calls: [],
      };
    }
    // P5: no successful convergence with unresolved task reconciliation or
    // status scouting still in flight.
    const reconciliation = reconciliationView(req, receipts);
    const outstanding = reconciliation.unresolved ?? [];
    if (outstanding.length > 0 || outstandingScouts(workers).length > 0) {
      return {
        say: `Holding: task reconciliation is outstanding (${outstanding.map((mark) => `#${mark.taskId}`).join(", ")} or status scouting in flight).`,
        calls: [],
      };
    }
    const incomplete = workers.filter((w) => (!w.purpose || w.purpose === "work") &&
      ["exited-without-done", "failed", "killed"].includes(w.state) && !completedResume(workers, w));
    if (incomplete.length || !workers.some((w) => w.completed && w.report)) {
      const key = inboxKey("wi", incomplete.map((w) => w.child_id).sort().join(",") || "no-reports");
      if (escalationSent(req.events, key, receipts)) {
        return { say: "Incomplete-worker escalation already sent; waiting for reconciliation.", calls: [] };
      }
      return escalateAction(req, {
        key, title: "Worker outcomes do not establish goal completion",
        body: incomplete.length
          ? `Goal was NOT completed. Reconcile or recover these workers: ${incomplete.map((w) => `${w.child_id} (${w.state})`).join(", ")}.`
          : "Goal was NOT completed: no completed worker reports were received.",
      });
    }
    const tree = taskTreeOf(req);
    const unclosed = tree.available && tree.ok ? tree.tree.tasks.filter((task) => blocking(req, task)) : [];
    if (unclosed.length) {
      const key = inboxKey("tt", unclosed.map((task) => task.id).sort((a, b) => a - b).join(","));
      if (escalationSent(req.events, key, receipts)) return {say: "Holding: authorized task outcomes remain unclosed.", calls: []};
      return escalateAction(req, {key, title: "Authorized tasks are not completed",
        body: `Goal was NOT completed. Authoritative tasks still require disposition: ${unclosed.map((task) => `#${task.id} (${task.status})`).join(", ")}. Fix task state, then answer; an answer alone does not close these tasks.`});
    }
    // Own-run tasks remain owned/in_progress here. The parent's result delivery
    // reverts them and P5 scouts/completes them with evidence, rather than this
    // pre-P7 convergence marking its own acceptance as independently verified.
    // Converge: the report the parent receives is every completed worker's report.
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
    // P5: dispatch is task-driven — eligible open tasks from the authoritative
    // snapshot ride as tasks:[id] with stream, cwd and a slot brief. Tasks with
    // a pending reconciliation mark are reserved for the scout flow, tasks
    // owned by live children are never double-dispatched, and no task is ever
    // invented from report prose.
    if (writerInWorktree(req, workers)) return {say: "Holding: a live or spawn-pending work arm already owns this worktree.", calls: []};
    const treeInfo = taskTreeOf(req);
    const eligibleTask = treeInfo.available && treeInfo.ok
      ? treeInfo.tree.tasks.find((task) => dispatchEligible(req, task, workers, receipts)) : undefined;
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
    const dispatched = eligibleTask ? taskDispatchCall(req, eligibleTask, agentType, "task-driven worker-arm dispatch", {rows: workers, receipts}) : null;
    if (dispatched) return dispatched;
    const assignedRun = defaultWorkCall(req, agentType, workers, receipts);
    if (assignedRun) return assignedRun;
    if (treeInfo.available && (!treeInfo.ok || treeInfo.tree.tasks.length > 0)) {
      return taskDispatchHold(req, treeInfo, workers, receipts);
    }
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
        bridgeVersion: BRIDGE_VERSION,
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
    const { evaluateJev, resolveProxyToken } = await jiti.import(JEV_EXTENSION);
    readStdinLines((line) => void decideOne(line, evaluateJev, resolveProxyToken));
  } catch (err) {
    fail(err?.stack || String(err));
  }
}

// ─── P7 convergence (bridge side) ────────────────────────────────────────────
//
// Shared state machine: convergence.ts owns the durable convergence journal
// (hash-chained `convergence:<operationId>` records inside the ordinary
// receipts). The bridge folds facts into it every turn, observes the
// authoritative work snapshot, computes readiness, and — only in mapAnswers —
// reserves/emits the independent verification, goal-status and synthesis arms.
// Empty/new (pre-P7) sessions keep the v6 compatibility path; an active P7
// journal under an unpaired extension escalates under stable key `pair-p7`.

const ARM_SLOT = /^(verification|goal_status|synthesis):(.+)$/;
const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

function canonicalSession(path) {
  try { return recovery.canonicalSessionPath(path); } catch { return undefined; }
}

/** One JSON entry per line of a session log; unparseable lines are skipped. */
function sessionEntries(sessionFile) {
  if (!sessionFile) return [];
  let raw;
  try { raw = readFileSync(sessionFile, "utf8"); } catch { return []; }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { const parsed = JSON.parse(trimmed); if (parsed && typeof parsed === "object") entries.push(parsed); } catch { /* not an entry line */ }
  }
  return entries;
}

/** Custom entries (subagent-spawn / subagent-complete / inbox-item / …). */
function sessionCustomEntries(sessionFile) {
  return sessionEntries(sessionFile).filter((entry) => entry?.type === "custom" && typeof entry.customType === "string");
}

/** Canonical task_update messages from the persisted session log. */
function persistedSessionMessages(sessionFile) {
  return sessionEntries(sessionFile).flatMap((entry) => sessionMessages.sessionMessagesFrom(entry));
}

/** P4 canonical task_update corrections for the authorized subtree, ordered. */
export function canonicalCorrections(req) {
  const authorized = new Set((req.state?.taskTree?.tasks ?? []).map((task) => task.id));
  const entries = new Map();
  const add = (entry) => {
    if (!entry || typeof entry.operationId !== "string" || !entry.operationId) return;
    if (typeof entry.correction !== "string" || !entry.correction) return;
    if (entry.taskIds?.length && !entry.taskIds.some((id) => authorized.has(id))) return;
    const identity = entry.identity ?? JSON.stringify(["task_update", entry.childId ?? entry.sessionFile ?? "", entry.operationId, entry.taskRevision ?? 0]);
    if (!entries.has(identity)) entries.set(identity, entry);
  };
  for (const message of persistedSessionMessages(req.agent?.sessionFile)) {
    if (message.kind !== "task_update") continue;
    add({operationId: message.operationId, taskRevision: message.taskRevision, correction: message.payload?.correction,
      taskIds: message.taskIds, childId: message.childId, sessionFile: message.sessionFile,
      identity: sessionMessages.taskUpdateIdentity(message)});
  }
  for (const decision of req.state?.sessionMessages?.taskUpdates ?? []) {
    add({operationId: decision.operationId, taskRevision: decision.revision, correction: decision.correction,
      taskIds: decision.taskIds, identity: typeof decision.id === "string" ? decision.id : undefined});
  }
  return [...entries.values()].sort((a, b) =>
    (a.taskRevision ?? 0) - (b.taskRevision ?? 0) || (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
}

/** The exact acceptance bytes: the initial task event plus every canonical P4 correction. */
export function acceptanceCriteria(req) {
  const events = req.events ?? [];
  const initial = events.find((e) => (e.type === "user_input" || e.type === "parent_message") && typeof e.text === "string") ??
    events.find((e) => e.type === "notification" && e.payload?.fromParent === true && typeof e.text === "string");
  // Fallback: the parent-authored spawn task env (PI_SUBAGENT_TASK), the same
  // memory-only source resolveGoal uses — carried verbatim, never budgeted.
  // Used only when no initial event survives the transcript (offline fixtures
  // and spawned runs whose brief lives in the env); never a restatement.
  const envTask = typeof process.env.PI_SUBAGENT_TASK === "string" ? process.env.PI_SUBAGENT_TASK : null;
  const initialText = initial ? String(initial.text) : envTask;
  if (!initialText || !initialText.trim()) {
    return {hold: {key: "p7-acceptance", title: "Acceptance criteria missing",
      body: "NOT completed. No canonical initial task event carries the acceptance criteria; no classifier-authored restatement is an acceptance source."}};
  }
  return {text: [initialText, ...canonicalCorrections(req).map((entry) => entry.correction)].join("\n\n")};
}

/** The authorized subtree projected onto the shared ConvergenceTaskSchema. */
function convergenceTasks(req) {
  const tree = taskTreeOf(req);
  if (!tree.available || !tree.ok) return null;
  return (tree.tree.tasks ?? []).map((task) => ({
    id: task.id, text: String(task.text ?? ""), status: task.status,
    ...(task.parentTaskId !== undefined ? {parentTaskId: task.parentTaskId} : {}),
    ...(task.supersededBy !== undefined ? {supersededBy: task.supersededBy} : {}),
    ...(task.ref !== undefined ? {ref: String(task.ref)} : {}),
    ...(task.assignedToId !== undefined ? {assignedToId: String(task.assignedToId)} : {}),
  }));
}

/** A task ref is a commit in req.agent.cwd (exact ref string as version) or a readable regular file (sha256). */
function taskRefEntry(task, cwd) {
  const ref = typeof task.ref === "string" ? task.ref.trim() : "";
  if (!ref) return [task.id, null, null, null];
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    try {
      const check = spawnSync("git", ["cat-file", "-t", ref], {cwd, timeout: 5000});
      if (check.status === 0 && String(check.stdout).trim() === "commit") return [task.id, ref, "commit", ref];
    } catch { /* not a repository — fall through to the file check */ }
  }
  const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
  try {
    const stat = statSync(path);
    if (stat.isFile() && stat.size > 0) return [task.id, ref, "sha256", sha256Hex(readFileSync(path))];
  } catch { /* unreadable */ }
  return {hold: {key: `p7-taskref-${task.id}`, infrastructureIssue: true, title: `Task #${task.id} evidence ref is unusable`,
    body: `NOT completed. Task #${task.id} ref "${ref}" is neither a commit in ${cwd} nor a readable regular file; no prose/path/mtime surrogate may stand in.`}};
}

function durableReportPath(row) {
  for (const candidate of [row.resultStorePath, row.sessionFile ? `${row.sessionFile}.report` : null]) {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) continue;
    try { const stat = statSync(candidate); if (stat.isFile() && stat.size > 0) return candidate; } catch { /* unreadable */ }
  }
  return null;
}

/**
 * The exact WorkSnapshotSchema: acceptance bytes, authorized tasks, every
 * work-purpose attempt child, the canonical implementation revision, and the
 * durable report manifest (report:<childId> ids, absolute paths, digests).
 */
export function workSnapshot(req, receipts) {
  const tasks = convergenceTasks(req);
  if (!tasks) {
    return {hold: {key: "p7-tree", title: "Authoritative task snapshot unavailable",
      body: `NOT completed. Missing task-store authority is a hold, never an empty task tree: ${taskTreeOf(req).error ?? "task tree unavailable"}.`}};
  }
  const cwd = req.agent?.cwd ?? process.cwd();
  const taskRefs = [];
  for (const task of [...tasks].sort((a, b) => a.id - b.id)) {
    const entry = taskRefEntry(task, cwd);
    if (entry.hold) return {hold: entry.hold};
    taskRefs.push(entry);
  }
  const acceptance = acceptanceCriteria(req);
  if (acceptance.hold) return {hold: acceptance.hold};
  const workRows = Object.values(receipts.lifecycle).filter((row) => row.purpose === "work")
    .map((row) => [row.childId, row.attempt ?? 1, row.state, row.resumedFrom ?? null, canonicalSession(row.sessionFile) ?? null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const workChildIds = [...new Set(Object.values(receipts.lifecycle).filter((row) => row.purpose === "work").map((row) => row.childId))];
  // scopeOperationIds: P4 correction history + committed task-update batch operationIds.
  const calls = callArgsById(req.events ?? []);
  const scopeOperationIds = [...new Set([
    ...canonicalCorrections(req).map((entry) => entry.operationId),
    ...Object.entries(receipts.operations).filter(([, operation]) => operation.tool === "task_update" || operation.tool === "task")
      .map(([id]) => id.replace(/^task-update-consumed:/, "")),
    ...(Array.isArray(req.events) ? req.events.flatMap((e) => {
      if (e.type !== "tool_result" || !["task", "task_update"].includes(e.tool)) return [];
      const call = calls.get(e.callId);
      const operationId = call?.args?.operationId ?? e.details?.operationId;
      return typeof operationId === "string" && operationId ? [operationId] : [];
    }) : []),
  ])].sort();
  // recoveryOperationIds: admitted recovery intents, resume reservations and resume controls.
  const recoveryOperationIds = [...new Set([
    ...Object.entries(receipts.operations).filter(([id, operation]) =>
      id.startsWith("recovery-intent:") && (operation.acknowledgement || operation.effect)).map(([id]) => id),
    ...Object.keys(receipts.resumeReservations),
    ...Object.entries(receipts.operations).filter(([, operation]) =>
      operation.effect?.tool === "subagent_resume" && receipts.lifecycle[operation.effect.childId]?.purpose === "work")
      .map(([id]) => id),
  ])].sort();
  const reports = Object.values(receipts.lifecycle)
    .filter((row) => row.purpose)
    .map((row) => {
      const path = durableReportPath(row);
      if (!path || row.state === "spawn_pending") return null;
      return {id: `report:${row.childId}`, path, childId: row.childId, purpose: row.purpose, evidenceRevision: sha256Hex(readFileSync(path))};
    })
    .filter(Boolean);
  return {snapshot: {
    acceptanceCriteria: acceptance.text,
    tasks,
    workChildIds,
    implementationRevision: sha256Hex(Buffer.from(JSON.stringify([workRows, scopeOperationIds, recoveryOperationIds, taskRefs]), "utf8")),
    reports,
  }};
}

/** The engine is the single P7 writer: observe the canonical snapshot at the next sequence. */
export function observeP7Work(req) {
  const sessionFile = req.agent?.sessionFile;
  if (!sessionFile) return {error: "no canonical parent agent.sessionFile"};
  let service;
  let state;
  try {
    service = convergence.createConvergenceServices(sessionFile);
    state = service.read();
  } catch (err) {
    return {error: `convergence state unreadable: ${err?.message ?? err}`};
  }
  const loaded = readOrchReceipts(sessionFile);
  if (loaded.corrupt) return {error: `orchestration receipts unreadable: ${loaded.error}`};
  const built = workSnapshot(req, loaded.receipts);
  if (built.hold) return {hold: built.hold};
  const snapshot = built.snapshot;
  if (state.snapshot && canonicalJson(state.snapshot) === canonicalJson(snapshot)) return {ok: true, unchanged: true};
  try {
    service.observe(`snapshot:${state.sequence + 1}:${convergence.workFingerprint(snapshot)}`, snapshot);
  } catch (err) {
    return {error: `convergence observation failed: ${err?.message ?? err}`};
  }
  return {ok: true};
}

/**
 * Extension/bridge pairing (spec §1). Returns {mode:'active'} when the P7
 * contract is fully satisfied, {mode:'pair', problems} when an active P7
 * journal is paired with an old/missing extension surface, and {mode:'compat'}
 * for empty/new sessions, which keep the v6 compatibility path.
 */
export function p7PairingProblem(req, receipts, ledger) {
  const convState = req.state?.convergence;
  const activeJournal = Object.keys(receipts.operations ?? {}).some((id) => id.startsWith("convergence:")) ||
    (convState?.state?.sequence ?? 0) > 0 || (convState?.state?.tickets?.length ?? 0) > 0;
  const problems = [];
  if (req.capabilities?.completionKind !== true) problems.push("capabilities.completionKind missing");
  if (req.capabilities?.completionDecisions !== true) problems.push("capabilities.completionDecisions missing");
  if (req.capabilities?.convergence !== 1) problems.push("capabilities.convergence missing (old extension)");
  if (convState?.v !== 1) problems.push("state.convergence.v missing (old extension)");
  if (!req.agent?.sessionFile) problems.push("no canonical parent agent.sessionFile");
  const context = req.state?.convergenceContext;
  if (!context || typeof context.cwd !== "string" || context.cwd !== req.agent?.cwd) problems.push("state.convergenceContext invalid");
  if (!Array.isArray(req.state?.inboxDecisions)) problems.push("state.inboxDecisions not durable");
  if (req.state?.convergenceError) problems.push(`state.convergenceError: ${req.state.convergenceError}`);
  const completions = completionRows(req);
  if (completions.error) problems.push(`completion journal error: ${completions.error}`);
  if (ledger?.corrupt) problems.push(`orchestration ledger corrupt: ${ledger.error}`);
  if (ledger?.writeError) problems.push(`orchestration ledger write failed: ${ledger.writeError}`);
  if (!activeJournal) return {mode: "compat", problems};
  if (!problems.length) return {mode: "active"};
  return {mode: "pair", problems};
}

/** Durable mutation facts folded through service.mutation before any dispatch/terminal attempt. */
function p7MutationFacts(req, receipts, repairOpen) {
  const facts = [];
  for (const entry of canonicalCorrections(req)) {
    if (receipts.operations[`convergence:${entry.operationId}`]?.effect) continue;
    facts.push({operationId: entry.operationId, reason: repairOpen ? "repair" : "scope"});
  }
  for (const [id, operation] of Object.entries(receipts.operations)) {
    if (id.startsWith("recovery-intent:") && (operation.acknowledgement || operation.effect) && !receipts.operations[`convergence:${id}`]?.effect) {
      facts.push({operationId: id, reason: "replacement"});
    }
  }
  for (const id of Object.keys(receipts.resumeReservations)) {
    if (receipts.operations[`convergence:${id}`]?.effect) continue;
    facts.push({operationId: id, reason: "resume"});
  }
  for (const [id, operation] of Object.entries(receipts.operations)) {
    if (operation.effect?.tool === "subagent_resume" && receipts.lifecycle[operation.effect.childId]?.purpose === "work" &&
        !receipts.operations[`convergence:${id}`]?.effect) facts.push({operationId: id, reason: "resume"});
  }
  return facts;
}

/**
 * Fold canonical lifecycle facts into the shared convergence journal:
 * mutations, arm launches from acknowledgements, arm completions from
 * lifecycle rows, admission failures from p7-<kind>-<ticketId> escalations,
 * and crash detection for reserved tickets with no spawn call at all.
 * Stable operation ids make every fold a no-op on replay.
 */
export function foldP7Facts(req) {
  const out = {errors: [], launchFailures: [], completionProblems: []};
  const sessionFile = req.agent?.sessionFile;
  if (!sessionFile) return out;
  let service;
  let state;
  try {
    service = convergence.createConvergenceServices(sessionFile);
    state = service.read();
  } catch (err) {
    out.errors.push(`convergence state unreadable: ${err?.message ?? err}`);
    return out;
  }
  const reload = () => {
    const loaded = readOrchReceipts(sessionFile);
    return loaded.receipts;
  };
  const run = (work) => {
    try { work(); } catch (err) { out.errors.push(err?.message ?? String(err)); }
  };
  if (state.snapshot) {
    const repairOpen = state.verification?.result.verdict === "changes_required";
    for (const fact of p7MutationFacts(req, reload(), repairOpen)) {
      run(() => service.mutation(fact.operationId, fact.reason));
    }
  }
  // Admission-failure escalations the extension emitted for a reserved arm slot.
  for (const [id, operation] of Object.entries(reload().operations)) {
    const match = /^escalation:p7-(verification|goal_status|synthesis)-(.+)$/.exec(id);
    if (!match || !operation.acknowledgement || operation.acknowledgement.isError) continue;
    const ticketId = match[2];
    const fresh = service.read();
    if (ticketId && fresh.tickets.some((ticket) => ticket.id === ticketId && ticket.status === "reserved")) {
      run(() => service.launch(ticketId, {isError: true, details: {infraIssue: true}}));
    }
  }
  const events = req.events ?? [];
  const calls = callArgsById(events);
  // Arm launches from the ordinary subagent acknowledgement.
  for (const e of events) {
    if (e.type !== "tool_result" || e.tool !== "subagent") continue;
    const call = calls.get(e.callId);
    const slot = call?.spawn?.slot ?? call?.args?.spawnSlot;
    const binding = ARM_SLOT.exec(slot ?? "");
    if (!binding) continue;
    const ticketId = binding[2];
    const fresh = service.read();
    if (!fresh.tickets.some((ticket) => ticket.id === ticketId && ticket.status === "reserved")) continue;
    run(() => service.launch(ticketId, {isError: e.isError === true, details: isRecord(e.details) ? e.details : {}}));
  }
  // Crash between reservation and emission: reserved, no call carries the slot, no lifecycle row.
  const freshTickets = service.read().tickets;
  const rows = reload();
  for (const ticket of freshTickets) {
    if (ticket.status !== "reserved") continue;
    const slot = `${ticket.kind}:${ticket.id}`;
    const callCarries = events.some((e) => e.type === "decision" && Array.isArray(e.calls) && e.calls.some((call) =>
      (call.spawn?.slot ?? call.args?.spawnSlot) === slot));
    const rowCarries = Object.values(rows.lifecycle).some((row) => row.spawnSlot === slot);
    if (callCarries || rowCarries) continue; // a call without its acknowledgement holds, never relaunches
    out.launchFailures.push({ticketId: ticket.id, slot, key: `p7-launch-${ticket.id}`});
    run(() => service.launch(ticket.id, {isError: true, details: {infraIssue: true}}));
  }
  // Arm completions from canonical lifecycle facts (purpose/report from the ledger, not the child).
  const finalTickets = service.read().tickets;
  const finalRows = reload();
  for (const ticket of finalTickets) {
    if (ticket.status !== "running" || !ticket.childId) continue;
    const row = finalRows.lifecycle[ticket.childId];
    if (!row || !["completed", "failed", "killed", "exited-without-done"].includes(row.state)) continue;
    const completion = {
      childId: row.childId,
      purpose: row.purpose,
      completionKind: row.completionKind ?? row.state,
      reportRef: row.sessionFile ? `${row.sessionFile}.report` : "",
      structured: row.structured,
      schemaViolated: row.schemaViolated === true,
      infraIssue: row.infraIssue === true,
    };
    try { service.complete(ticket.id, completion); }
    catch (err) { out.completionProblems.push({ticketId: ticket.id, error: err?.message ?? String(err)}); }
  }
  return out;
}

/** All mandatory RunReadiness fields (spec §4); nonzero counts block reservation and done. */
export function p7Readiness(req, convState, ledger) {
  const sessionFile = req.agent?.sessionFile;
  const loaded = readOrchReceipts(sessionFile);
  const receipts = loaded.receipts;
  const tree = taskTreeOf(req);
  const tasks = convergenceTasks(req);
  const completions = completionRows(req);
  const inboxItems = sessionFile && inbox?.reconstructInbox ? [...inbox.reconstructInbox(sessionCustomEntries(sessionFile)).values()] : [];
  const liveStates = ["spawn_pending", "running", "interrupted", "resumed"];
  const liveIds = new Set();
  const visitedSessions = new Set();
  const collectLive = (rows, depth) => {
    for (const row of Object.values(rows.lifecycle)) {
      if (liveStates.includes(row.state)) liveIds.add(row.childId);
      const path = canonicalSession(row.sessionFile);
      if (path && !visitedSessions.has(path) && depth < 3) {
        visitedSessions.add(path);
        const child = readOrchReceipts(path);
        if (!child.corrupt) collectLive(child.receipts, depth + 1);
      }
    }
  };
  visitedSessions.add(canonicalSession(sessionFile));
  collectLive(receipts, 0);
  const asks = new Set(pendingAsks(req.events ?? []).map((ask) => ask.askId));
  for (const [id, ask] of Object.entries(req.state?.sessionMessages?.asks ?? {})) if (ask?.status === "pending") asks.add(id);
  for (const row of req.state?.completionDecisions ?? []) for (const id of row?.pendingAskIds ?? []) asks.add(id);
  const notifications = new Set((req.state?.taskUpdateOutbox?.pending ?? []).map((row) => row.key));
  for (const completion of req.state?.sessionMessages?.completions ?? []) {
    const identity = completion.resultStorePath ?? completion.eventId;
    if (identity && !receipts.consumedCompletions.includes(`${completion.childId}:${identity}`)) notifications.add(completion.eventId ?? identity);
  }
  const actions = new Set();
  for (const id of Object.keys(req.state?.sessionMessages?.operations ?? {})) actions.add(id);
  for (const [id, operation] of Object.entries(receipts.operations)) {
    if (operation.intent && !operation.acknowledgement && !operation.effect && !operation.reconciled) actions.add(id);
  }
  for (const row of completions.rows) {
    if (row.status === "offered" && completionDecisions.isPendingCompletion(row)) actions.add(`completion-terminal:${row.offer?.completionId}`);
  }
  for (const ticket of convState?.tickets ?? []) if (ticket.status === "reserved") actions.add(`convergence:launch:${ticket.id}`);
  const recoveries = new Set();
  for (const [id, operation] of Object.entries(receipts.operations)) {
    if (id.startsWith("recovery-intent:") && !operation.effect && !operation.reconciled) recoveries.add(id);
    if (id.startsWith("recovery-effect:") && !operation.acknowledgement && !operation.effect) recoveries.add(id);
  }
  for (const id of Object.keys(receipts.resumeReservations)) recoveries.add(id);
  const statusScouts = new Set([
    ...statusReconciliation.pendingStatusReconciliations(receipts).map((mark) => mark.operationId),
    ...(req.state?.statusReconciliation?.unresolved ?? []).map((mark) => mark.operationId),
  ]);
  for (const row of Object.values(receipts.lifecycle)) {
    if (row.purpose === "status_scout" && liveStates.includes(row.state)) statusScouts.add(row.spawnSlot ?? row.childId);
  }
  const approvals = new Set();
  for (const item of inboxItems) if (item.decide && !item.decision) approvals.add(item.id);
  for (const item of req.state?.inboxDecisions ?? []) if (item.ackedTs !== undefined && !item.decision) approvals.add(item.id);
  return {
    authoritative: Boolean(tree.available && tree.ok && req.state?.taskUpdateOutbox?.ok !== false && sessionFile &&
      !loaded.corrupt && !ledger?.corrupt && !ledger?.writeError && !req.state?.convergenceError && !completions.error && convState),
    taskProblems: tasks ? convergence.taskClosureProblems(tasks) : ["authoritative task tree unavailable"],
    liveChildren: liveIds.size,
    pendingAsks: asks.size,
    pendingNotifications: notifications.size,
    pendingActions: actions.size,
    pendingRecovery: recoveries.size,
    pendingStatusScouts: statusScouts.size,
    unresolvedApprovals: approvals.size,
  };
}

/** Final forwarding preflight: the exact sidecar the forwarder will resolve, nothing else. */
export function resolveP7Forward(state, req) {
  if (!state.synthesis) return null;
  const childId = state.synthesis.childId;
  let spawn;
  let completed = false;
  for (const entry of sessionCustomEntries(req.agent?.sessionFile)) {
    const data = isRecord(entry.data) ? entry.data : {};
    if (data.id !== childId) continue;
    if (entry.customType === "subagent-spawn") spawn = data;
    else if (entry.customType === "subagent-complete") completed = true;
  }
  if (!spawn || !completed || typeof spawn.sessionFile !== "string" || !spawn.sessionFile.trim()) return null;
  const path = `${spawn.sessionFile}.report`;
  let stat;
  try { stat = statSync(path); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;
  if (path !== state.synthesis.reportRef) return null;
  return {childId, reportRef: path};
}

function escalateOnce(req, receipts, spec) {
  if (escalationSent(req.events, spec.key, receipts)) {
    return {say: `${spec.title} escalation already sent; holding.`, calls: []};
  }
  return escalateAction(req, spec);
}

function freshReceipts(sessionFile) {
  return readOrchReceipts(sessionFile).receipts;
}

function convergenceService(req) {
  return convergence.createConvergenceServices(req.agent.sessionFile);
}

function p7HeldConvergence(req, answers, p7) {
  if (p7.hold) return {say: `Holding: the convergence work snapshot is unavailable (${p7.hold.title}).`, calls: []};
  return p7ConvergenceAction(req, answers);
}

/** The repair_decision arm: finite options, escalation always available (spec §5). */
function p7RepairDecision(req, service, state, answers) {
  const ticketId = state.verification.ticketId;
  const reportRef = state.verification.reportRef;
  const findings = state.verification.result.findings;
  const receipts = freshReceipts(req.agent.sessionFile);
  if (!Object.hasOwn(answers ?? {}, "p7_repair")) {
    return {say: "Repair decision arrived during classification; waiting for its notice.", calls: []};
  }
  const choice = answers.p7_repair?.choice;
  if (choice === "escalate" || !choice) {
    return escalateOnce(req, receipts, {key: `p7-repair:${ticketId}:escalate`,
      title: `Verification findings (${ticketId}) need repair or escalation`,
      body: `NOT completed. Verifier report: ${reportRef}\nFindings:\n${findings.map((finding) => `- ${finding}`).join("\n")}`});
  }
  if (choice.startsWith("apply:")) {
    const offer = completionRows(req).rows.find((row) => row.status === "offered" && completionDecisions.isPendingCompletion(row));
    const optionId = choice.slice("apply:".length);
    if (!offer || !offer.offer.decisions.some((option) => option.id === optionId)) {
      return escalateOnce(req, receipts, {key: `p7-repair:${ticketId}`, infrastructureIssue: true,
        title: "Offered repair option is unavailable",
        body: `NOT completed. No admitted completion offer carries option "${optionId}" for verifier ${ticketId}.`});
    }
    if (!req.tools.some((tool) => tool.name === "apply_decision")) {
      return escalateOnce(req, receipts, {key: `p7-repair:${ticketId}`, infrastructureIssue: true,
        title: "Completion executor unavailable", body: `NOT completed. Reload with apply_decision. Report: ${reportRef}`});
    }
    try { service.mutation(`completion-action:${offer.offer.completionId}:${optionId}`, "repair"); }
    catch (err) { return escalateOnce(req, receipts, {key: `p7-repair:${ticketId}`, infrastructureIssue: true,
      title: "Repair mutation failed", body: `NOT completed. ${err?.message ?? err}`}); }
    return {say: `Applying the verifier-offered repair option ${optionId}.`, calls: [{
      tool: "apply_decision",
      args: {completionId: offer.offer.completionId, snapshotRevision: offer.offer.snapshotRevision,
        offerHash: offer.offer.offerHash, reportRef: offer.offer.reportRef, optionId},
      reason: "verifier-offered finite repair option",
    }]};
  }
  if (choice === "dispatch_thinker") {
    const slot = (req.spawnContexts ?? []).find((entry) => entry.purpose === "think");
    if (!slot) {
      return escalateOnce(req, receipts, {key: `p7-repair:${ticketId}`, infrastructureIssue: true,
        title: "No admitted thinker slot for repair reasoning",
        body: `NOT completed. Verifier report: ${reportRef}\nFindings:\n${findings.map((finding) => `- ${finding}`).join("\n")}`});
    }
    const errors = [];
    persistClaim(req.agent.sessionFile, freshReceipts(req.agent.sessionFile), {v: 1, seq: 0, ts: Date.now(),
      operationId: `p7-repair:${ticketId}:dispatch_thinker`, tool: "repair_dispatch", phase: "effect",
      detail: {ticketId, reportRef}}, errors);
    if (errors.length) return escalateOnce(req, receipts, {key: `p7-repair:${ticketId}`, infrastructureIssue: true,
      title: "Repair dispatch journal write failed", body: `NOT completed. ${errors.join("; ")}`});
    return {say: `Dispatching the repair thinker with the verifier findings (${ticketId}).`, calls: [{
      tool: "subagent", args: {agent: "thinker", purpose: "think"}, spawn: {slot: slot.id},
      reason: "repair reasoning routed to an admitted thinker slot",
    }]};
  }
  return escalateOnce(req, receipts, {key: `p7-repair:${ticketId}`, infrastructureIssue: true,
    title: "Unoffered repair option", body: `NOT completed. "${choice}" is not an offered repair option.`});
}

/** The synthesis_correction_decision arm: corrected synthesis or escalation, nothing else. */
function p7SynthesisCorrection(req, service, state, answers) {
  const prior = state.tickets.at(-1);
  const ticketId = prior?.id ?? "synthesis";
  const receipts = freshReceipts(req.agent.sessionFile);
  if (!Object.hasOwn(answers ?? {}, "p7_synthesis_correction")) {
    return {say: "Synthesis correction decision arrived during classification; waiting for its notice.", calls: []};
  }
  const choice = answers.p7_synthesis_correction?.choice;
  if (choice !== "corrected_synthesis") {
    return escalateOnce(req, receipts, {key: `p7-synthesis-correction:${ticketId}`,
      title: `Synthesis coverage (${ticketId}) needs correction or escalation`,
      body: `NOT completed. Prior synthesis report: ${state.synthesisProblems ? `${prior?.reportRef ?? "(none)"}` : "(none)"}\nCoverage problems:\n${(state.synthesisProblems ?? []).map((problem) => `- ${problem}`).join("\n")}`});
  }
  const readiness = p7Readiness(req, service.read(), {corrupt: false, writeError: null});
  const fresh = service.read();
  const nextId = `synthesis-${fresh.sequence + 1}`;
  let reservedState;
  try { reservedState = service.reserve(nextId, "synthesis", readiness); }
  catch (err) {
    return escalateOnce(req, receipts, {key: `p7-synthesis-correction:${ticketId}`, infrastructureIssue: true,
      title: "Corrected synthesis could not be reserved", body: `NOT completed. ${err?.message ?? err}`});
  }
  if (reservedState.failure) return p7ConvergenceAction(req, answers);
  return {say: `Reserving the corrected synthesis arm (${nextId}).`, calls: [{
    tool: "subagent", args: {agent: "worker", purpose: "synthesis"}, spawn: {slot: `synthesis:${nextId}`},
    reason: "corrected synthesis reserved",
  }]};
}

/**
 * The P7 convergence selection (mapAnswers only): wait/verify/synthesize/
 * repair/synthesis-correction/forward/escalate from convergenceNext, gated on
 * clean readiness. Reservation precedes emission; caps and terminal failure
 * live in the shared state machine, never in classifier confidence.
 */
export function p7ConvergenceAction(req, answers) {
  const sessionFile = req.agent.sessionFile;
  const receipts = freshReceipts(sessionFile);
  let service;
  let state;
  try {
    service = convergenceService(req);
    state = service.read();
  } catch (err) {
    return escalateOnce(req, receipts, {key: "p7-state", infrastructureIssue: true,
      title: "Convergence journal is unreadable", body: `NOT completed. ${err?.message ?? err}`});
  }
  const next = convergence.convergenceNext(state);
  if (next.kind === "escalate") {
    const prior = Object.keys(receipts.operations).some((id) =>
      id.startsWith("escalation:p7-") && receipts.operations[id].acknowledgement && !receipts.operations[id].acknowledgement.isError);
    if (prior || escalationSent(req.events, "p7-failure", receipts)) {
      return {say: "Holding: the P7 failure escalation is already recorded.", calls: []};
    }
    return escalateAction(req, {key: "p7-failure", infrastructureIssue: true,
      title: "Convergence run failed — NOT completed",
      body: `NOT completed. The independent convergence run failed terminally: ${state.failure}. Recovery requires a new session; no retry, no receipt reset, and no further ticket is authorized in this session.`});
  }
  if (next.kind === "wait") return {say: "Holding: an independent convergence arm is reserved or running.", calls: []};
  if (next.kind === "repair_decision") return p7RepairDecision(req, service, state, answers);
  if (next.kind === "synthesis_correction_decision") return p7SynthesisCorrection(req, service, state, answers);
  if (next.kind === "forward") {
    let available;
    try { available = resolveP7Forward(state, req); } catch { available = null; }
    if (!available) {
      return escalateOnce(req, receipts, {key: "p7-forward", infrastructureIssue: true,
        title: "Synthesis report is not available for exact forwarding",
        body: `NOT completed. The completed direct synthesis child's subagent-spawn/subagent-complete entries, nonempty ${"`${child.sessionFile}.report`"} sidecar and matching state.synthesis.reportRef preflight failed; the forwarder's fallback must not turn an engine placeholder into a success report.`});
    }
    try {
      const args = service.forward(p7Readiness(req, service.read(), {corrupt: false, writeError: null}), available);
      return {terminal: true, say: "Forwarding the verified synthesis report verbatim.",
        calls: [{tool: "subagent_done", args, reason: "converged through P7 verification and synthesis"}]};
    } catch (err) {
      return escalateOnce(req, receipts, {key: "p7-forward", infrastructureIssue: true,
        title: "Final forwarding gate refused", body: `NOT completed. ${err?.message ?? err}`});
    }
  }
  // verify / synthesize
  const readiness = p7Readiness(req, state, {corrupt: false, writeError: null});
  if (readiness.authoritative !== true || readiness.taskProblems.length ||
      ["liveChildren", "pendingAsks", "pendingNotifications", "pendingActions", "pendingRecovery", "pendingStatusScouts", "unresolvedApprovals"]
        .some((field) => readiness[field] !== 0)) {
    return {say: `Holding: convergence readiness is not clean (${[
      ...(readiness.authoritative !== true ? ["authoritative state unavailable"] : []),
      ...readiness.taskProblems,
      ...["liveChildren", "pendingAsks", "pendingNotifications", "pendingActions", "pendingRecovery", "pendingStatusScouts", "unresolvedApprovals"]
        .filter((field) => readiness[field] !== 0).map((field) => `${field}: ${readiness[field]}`),
    ].join("; ")}).`, calls: []};
  }
  if (!req.tools.some((tool) => tool.name === "subagent")) {
    return escalateOnce(req, receipts, {key: "p7-spawn", infrastructureIssue: true,
      title: "Convergence arm cannot be spawned",
      body: "NOT completed. This session has no subagent spawn tool, so independent verification/synthesis is impossible here."});
  }
  const kind = next.kind === "synthesize" ? "synthesis" : state.snapshot.workChildIds.length > 0 ? "verification" : "goal_status";
  const ticketId = `${kind}-${state.sequence + 1}`;
  let reservedState;
  try { reservedState = service.reserve(ticketId, kind, readiness); }
  catch (err) {
    const after = (() => { try { return service.read(); } catch { return null; } })();
    if (after?.failure) return p7ConvergenceAction(req, answers);
    return escalateOnce(req, receipts, {key: `p7-${kind}-${ticketId}`, infrastructureIssue: true,
      title: `Convergence ${kind} arm could not be reserved`,
      body: `NOT completed. ${err?.message ?? err}\nspawn_slot: ${kind}:${ticketId}`});
  }
  if (reservedState.failure) return p7ConvergenceAction(req, answers);
  const agent = kind === "synthesis"
    ? (answers?.worker_agent?.choice && answers.worker_agent.choice !== "other" ? answers.worker_agent.choice : "worker")
    : scoutAgent(req) ?? "scout";
  return {say: `Reserving the independent ${kind} arm (${ticketId}) at work revision ${reservedState.workRevision}.`,
    calls: [{tool: "subagent", args: {agent, purpose: kind === "synthesis" ? "synthesis" : "verification_scout"},
      spawn: {slot: `${kind}:${ticketId}`}, reason: `convergence ${kind} arm reserved at work revision ${reservedState.workRevision}`}]};
}

/** Implementation appears closed: every authorized task closed with evidence and no live work child. */
function p7ImplementationClosed(req) {
  const tree = taskTreeOf(req);
  const tasks = convergenceTasks(req);
  if (!tree.available || !tree.ok || !tasks) return false;
  if (convergence.taskClosureProblems(tasks).length) return false;
  const receipts = freshReceipts(req.agent?.sessionFile);
  return !Object.values(receipts.lifecycle).some((row) => row.purpose === "work" &&
    ["spawn_pending", "running", "interrupted", "resumed"].includes(row.state));
}

/**
 * mapAnswers wrapper (P7): pairing → fold → observe → P3–P6 handlers → P7
 * convergence selection. Empty/new sessions keep the v6 path unchanged.
 */
export function mapAnswers(answers, req) {
  if (doneAlreadyCalled(req.events)) {
    return {terminal: true, say: "Already reported done; ending.", calls: []};
  }
  const sessionFile = req.agent?.sessionFile;
  const first = sessionFile
    ? mergedWorkers(sessionFile, req.events, req.capabilities)
    : {rows: [], ledger: {corrupt: false}, receipts: emptyReceipts()};
  const pairing = p7PairingProblem(req, first.receipts, first.ledger);
  if (pairing.mode === "pair") {
    if (escalationSent(req.events, "pair-p7", first.receipts)) {
      return {say: "P7 pairing escalation already sent; reload the paired extension and bridge.", calls: []};
    }
    return escalateAction(req, {key: "pair-p7", infrastructureIssue: true, title: "P7 extension/bridge pair required",
      body: `NOT completed. An active P7 convergence journal requires the paired extension's convergence contracts and durable projections: ${pairing.problems.join("; ")}. Reload both together before resuming this session's decisions; an unpaired run may not spawn, dispatch, or report success.`});
  }
  if (pairing.mode === "compat") return mapAnswersCore(answers, req, {active: false});
  // Active P7 session: fold, observe, then the P3–P6 handlers, then the P7 selection.
  const receipts = freshReceipts(sessionFile);
  const fold = foldP7Facts(req);
  const holdSpec = fold.errors.length
    ? {key: "p7-state", infrastructureIssue: true, title: "Convergence journal failure", body: `NOT completed. ${fold.errors.join("; ")}`}
    : fold.completionProblems.length
      ? {key: `p7-complete:${fold.completionProblems.map((problem) => problem.ticketId).sort().join(",")}`, infrastructureIssue: true,
        title: "Independent arm completion is not foldable", body: `NOT completed. ${fold.completionProblems.map((problem) => `${problem.ticketId}: ${problem.error}`).join("; ")}`}
      : fold.launchFailures.length
        ? {key: fold.launchFailures[0].key, infrastructureIssue: true, title: "Reserved convergence launch unresolved",
          body: `NOT completed. Ticket ${fold.launchFailures[0].ticketId} is reserved with no spawn call or acknowledgement in the transcript.\nspawn_slot: ${fold.launchFailures[0].slot}`}
        : null;
  const observed = observeP7Work(req);
  const observeHold = observed.error
    ? {key: "p7-observe", infrastructureIssue: true, title: "Convergence observation failed", body: `NOT completed. ${observed.error}`}
    : observed.hold ?? null;
  const p7 = {active: true, hold: holdSpec ?? observeHold};
  const v6 = mapAnswersCore(answers, req, p7);
  const passive = !v6.calls?.length;
  const genericSpawn = v6.calls?.length === 1 && v6.calls[0].tool === "subagent" &&
    !v6.calls[0].spawn?.slot && !v6.calls[0].args?.tasks;
  if (p7.hold && (passive || genericSpawn)) return escalateOnce(req, freshReceipts(sessionFile), p7.hold);
  if (p7ImplementationClosed(req) && (passive || genericSpawn)) return p7ConvergenceAction(req, answers);
  return v6;
}

/**
 * buildRequest wrapper (P7): pairing → fold → observe, then the v6 request
 * body plus convergence facts and the finite repair/synthesis-correction
 * questions. buildRequest only exposes decisions; emission stays in mapAnswers.
 */
export function buildRequest(req) {
  const result = buildRequestCore(req);
  const sessionFile = req.agent?.sessionFile;
  if (!sessionFile) return result;
  const {receipts, ledger} = mergedWorkers(sessionFile, req.events, req.capabilities);
  const pairing = p7PairingProblem(req, receipts, ledger);
  if (pairing.mode === "compat") return result;
  if (pairing.mode === "pair") {
    return {...result, state: {...result.state, p7_pairing_error: pairing.problems.join("; ")}};
  }
  const fold = foldP7Facts(req);
  const observed = observeP7Work(req);
  let convState;
  try { convState = convergenceService(req).read(); } catch { convState = undefined; }
  const next = convState ? convergence.convergenceNext(convState) : undefined;
  const questions = {...result.questions};
  if (next?.kind === "repair_decision") {
    const completions = completionRows(req);
    const offered = completions.rows.find((row) => row.status === "offered" && completionDecisions.isPendingCompletion(row) &&
      row.offer?.reportRef === convState.verification.reportRef);
    const thinker = (req.spawnContexts ?? []).some((slot) => slot.purpose === "think");
    questions.p7_repair = {type: "choice",
      instructions: `Independent verification (${convState.verification.ticketId}) returned changes_required. Verifier report: ${convState.verification.reportRef}. Findings:\n${convState.verification.result.findings.map((finding) => `- ${finding}`).join("\n")}\nChoose exactly one repair route; escalation is always available. Repair work must land as admitted task updates before any re-verification.`,
      criteria: {
        escalate: "Emit NOT completed with the verifier report pointer and findings verbatim.",
        ...(thinker ? {dispatch_thinker: "Dispatch one admitted thinker slot with the verifier findings to obtain repair task edits/briefs (report-only; no implementation)."} : {}),
        ...(offered ? Object.fromEntries(offered.offer.decisions.map((option) => [`apply:${option.id}`, `Execute the verifier's admitted offered option "${option.id}" exactly through apply_decision.`])) : {}),
      }};
  }
  if (next?.kind === "synthesis_correction_decision") {
    const prior = convState.tickets.at(-1);
    questions.p7_synthesis_correction = {type: "choice",
      instructions: `Synthesis coverage missed obligations. Prior synthesis report: ${prior?.reportRef ?? "(none)"}. Coverage problems:\n${(convState.synthesisProblems ?? []).map((problem) => `- ${problem}`).join("\n")}\nChoose exactly one: the single corrected synthesis attempt, or escalation.`,
      criteria: {
        corrected_synthesis: "Reserve the corrected synthesis arm with the prior pointer and coverage obligations.",
        escalate: "Emit NOT completed with the prior synthesis pointer and exact coverage problems.",
      }};
  }
  return {...result, questions, state: {...result.state,
    ...(convState ? {convergence: {v: 1, state: convState}} : {}),
    ...(fold.errors.length ? {p7_journal_error: fold.errors.join("; ")} : {}),
    ...(fold.launchFailures.length ? {p7_launch_failures: fold.launchFailures} : {}),
    ...(observed.error ? {p7_observe_error: observed.error} : {}),
    ...(observed.hold ? {p7_snapshot_hold: observed.hold.body} : {}),
  }};
}
