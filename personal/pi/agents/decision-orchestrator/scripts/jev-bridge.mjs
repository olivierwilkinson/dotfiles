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

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { createJiti } from "@mariozechner/jiti";

const JEV_EXTENSION =
  "/Users/olivier/.pi/agent/git/github.com/shopify-playground/shop-pi-fy/extensions/jev/index.ts";
const MODEL = process.env.JEV_MODEL || "jev-latest";
const OUTPUT_LIMIT = 400;

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

function digestEvents(events) {
  return events.slice(-30).map((e) => {
    switch (e.type) {
      case "user_input":
      case "parent_message":
      case "reminder":
        return { kind: e.type, text: String(e.text).slice(0, 400) };
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
 * Every worker this orchestrator has spawned, with per-worker completion from
 * the subagent_result notices (matched by the spawned name). A spawn only
 * counts as running when its tool call succeeded; a failed spawn stays
 * visible as spawn_failed so the engine can choose to retry.
 */
function workersState(events) {
  const calls = callArgsById(events);
  const workers = new Map();
  for (const e of events) {
    if (e.type !== "tool_result" || e.tool !== "subagent") continue;
    const call = calls.get(e.callId);
    const name = String(call?.args?.name ?? "Goal worker");
    if (e.isError) {
      const w = workers.get(name);
      if (w) {
        w.running = false;
        w.spawn_failed = true;
      } else {
        workers.set(name, {
          name,
          agent: call?.args?.agent ?? null,
          child_id: null,
          running: false,
          spawn_failed: true,
          completed: false,
          verdict: null,
          report: null,
        });
      }
      continue;
    }
    const childId = /Id:\s*([0-9a-f-]{6,})/i.exec(String(e.output ?? ""))?.[1] ?? null;
    workers.set(name, {
      name,
      agent: call?.args?.agent ?? null,
      child_id: childId,
      running: childId !== null,
      spawn_failed: false,
      completed: false,
      verdict: null,
      report: null,
    });
  }
  for (const e of events) {
    if (e.type !== "notification" || e.kind !== "subagent_result") continue;
    const w = workers.get(String(e.payload?.name ?? ""));
    if (!w) continue;
    w.running = false;
    w.completed = true;
    const text = String(e.text ?? "");
    // Workers that finish naturally (no subagent_done call) still report
    // "completed"; without an explicit verdict treat that as done, or
    // convergence would depend on the child remembering to use the tool.
    w.verdict = /verdict:\s*(\w+)/.exec(text)?.[1] ?? (/completed/i.test(text) ? "done" : null);
    const stored = e.payload?.resultStorePath ?? /Stored path:\s*(\S+)/.exec(text)?.[1];
    let report = text;
    if (stored) {
      try {
        report = readFileSync(stored, "utf8");
      } catch {
        // store unreadable — the notice text still carries the essentials
      }
    }
    w.report = report.slice(0, 4000);
  }
  return [...workers.values()];
}

/** True once subagent_done has executed successfully — the run is over. */
function doneAlreadyCalled(events) {
  return events.some(
    (e) => e.type === "tool_result" && e.tool === "subagent_done" && !e.isError,
  );
}

/** The goal text: the spawn's `PI_SUBAGENT_TASK` env when present (artifact handoff buries it in an expanded wrapper blob), else the first user/parent message. */
function resolveGoal(events) {
  const fromEnv = process.env.PI_SUBAGENT_TASK?.trim();
  if (fromEnv) return fromEnv.slice(0, 4000);
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

/** Worker-agent choices from the request roster; the generic trio when no roster is published. */
function workerAgentQuestion(req) {
  const roster = Array.isArray(req.roster) ? req.roster : [];
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

function buildRequest(req) {
  const goal = resolveGoal(req.events);
  const workers = workersState(req.events);
  const doneCalled = doneAlreadyCalled(req.events);
  const agentQuestion = workerAgentQuestion(req);
  const targetQuestion = checkInTargetQuestion(workers);
  return {
    model: MODEL,
    state: {
      goal: goal.slice(0, 1000),
      agent_instructions: String(req.instructions ?? "").slice(0, 800),
      available_tools: req.tools.map((t) => t.name),
      spawn_args: readSpawnArgs(req.agent?.sessionFile),
      workers: workers.map((w) => ({
        name: w.name,
        agent: w.agent,
        child_id: w.child_id,
        running: w.running,
        spawn_failed: w.spawn_failed,
        completed: w.completed,
        verdict: w.verdict,
        report: w.report?.slice(0, 1500) ?? null,
      })),
      done_already_reported: doneCalled,
      recent_events: digestEvents(req.events),
      run_state: req.state ?? null,
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
          "What should the orchestrator do on this turn, given `state.goal`, `state.workers` (name / agent / running / spawn_failed / completed / verdict / report) and `state.recent_events`?",
        criteria: {
          spawn_worker:
            "A piece of the goal's work has no worker yet (never spawned, or a spawn failed and should be retried), or a worker finished and clearly more delegated work remains. Multiple workers may run in parallel or sequence.",
          wait:
            "Workers are running and not all of their results have arrived (`state.workers` still has `running: true`); the orchestrator should do nothing this turn.",
          report_done:
            "All delegated work is finished (every spawned worker completed with done verdicts) or the goal conclusively cannot proceed; report the outcome upward now.",
          check_in:
            "A running worker may be stuck or off-course; a brief status check to it is warranted.",
          other: "None of these describe the current situation.",
        },
      },
      worker_agent: agentQuestion,
      ...(targetQuestion ? { check_in_target: targetQuestion } : {}),
    },
  };
}

/** One converged result from every completed worker's report. */
function convergeReport(workers, done, next) {
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

function mapAnswers(answers, req) {
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
  const workers = workersState(req.events);

  if (done >= 0.5 || next === "report_done") {
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
  if (next === "spawn_worker") {
    // The goal is orchestrator-facing; the worker needs its work, not the
    // orchestration meta-instructions (waiting, converging, watch-demo holds).
    const task =
      "You are the worker: do the work below in one pass. Instructions about orchestrating, waiting, converging, or reporting upward are for your parent, not you — finish by calling subagent_done with your report.\n\n" +
      goal.slice(0, 2000);
    const name = `Worker ${workers.length + 1}`;
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
  if (next === "check_in") {
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

try {
  const { evaluateJev, resolveProxyToken } = await createJiti(import.meta.url).import(JEV_EXTENSION);
  readStdinLines((line) => void decideOne(line, evaluateJev, resolveProxyToken));
} catch (err) {
  fail(err?.stack || String(err));
}
