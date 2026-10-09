#!/usr/bin/env node
// jev-bridge: stdio decision engine for the `decision` provider.
//
// Reads one pi-decision-v1 DecisionRequest JSON line on stdin, asks the jev
// engine (TypeSafe System One via Shopify AI Proxy, using the shop-pi-fy jev
// extension's request/auth code) a fixed question battery, maps the answers
// to concrete tool calls, and writes one DecisionResult JSON line to stdout.
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
      default:
        return { kind: e.type };
    }
  });
}

/** Spawn status from tool results: a spawn only counts when the tool call SUCCEEDED. */
function spawnState(events) {
  let spawned = false;
  let childId = null;
  let spawnFailed = false;
  for (const e of events) {
    if (e.type !== "tool_result" || e.tool !== "subagent") continue;
    if (e.isError) {
      spawnFailed = true;
    } else {
      spawned = true;
      spawnFailed = false;
      childId = /Id:\s*([0-9a-f-]{6,})/i.exec(String(e.output ?? ""))?.[1] ?? childId;
    }
  }
  return { spawned, childId, spawnFailed };
}

/** True once subagent_done has executed successfully — the run is over. */
function doneAlreadyCalled(events) {
  return events.some(
    (e) => e.type === "tool_result" && e.tool === "subagent_done" && !e.isError,
  );
}

/** The goal text: the first user/parent message, resolving `@artifact` handoffs. */
function resolveGoal(events) {
  const raw =
    events.find((e) => e.type === "user_input")?.text ??
    events.find((e) => e.type === "parent_message")?.text ??
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

function buildRequest(req) {
  const goal = resolveGoal(req.events);
  const { spawned, childId, spawnFailed } = spawnState(req.events);
  const doneCalled = doneAlreadyCalled(req.events);
  return {
    model: MODEL,
    state: {
      goal: goal.slice(0, 1000),
      agent_instructions: String(req.instructions ?? "").slice(0, 800),
      available_tools: req.tools.map((t) => t.name),
      worker: { spawned, spawn_failed: spawnFailed, child_id: childId },
      done_already_reported: doneCalled,
      recent_events: digestEvents(req.events),
      run_state: req.state ?? null,
    },
    questions: {
      done: {
        type: "noul",
        instructions:
          "Given `state.goal` and `state.recent_events` (including any completed child-agent reports), is the goal fully achieved with nothing important left to do?",
      },
      next_action: {
        type: "choice",
        instructions:
          "What should the orchestrator do on this turn, given `state.goal`, `state.worker` (spawned / spawn_failed / child_id), and `state.recent_events`?",
        criteria: {
          spawn_worker:
            "No worker is running (`state.worker.spawned` is false — never spawned, or the spawn call failed and should be retried), or a worker finished and clearly more delegated work remains.",
          wait:
            "A worker is running and its result has not arrived yet; the orchestrator should do nothing this turn.",
          report_done:
            "The work is finished (or conclusively cannot proceed); report the outcome upward now.",
          check_in:
            "A running worker may be stuck or off-course; a brief status check to it is warranted.",
          other: "None of these describe the current situation.",
        },
      },
      worker_agent: {
        type: "choice",
        instructions:
          "If a worker is spawned for `state.goal`, which agent type fits the work described there best?",
        criteria: {
          worker:
            "General doing: implementing, running commands, tests, builds, commits.",
          scout:
            "Read-only checking: verifying claims, inspecting code or state, research.",
          monitor: "Watching one resource over time and reporting on change.",
          other: "None of these fit.",
        },
      },
    },
  };
}

function mapAnswers(answers, req) {
  // The report was already delivered — never call subagent_done twice.
  if (doneAlreadyCalled(req.events)) {
    return { terminal: true, say: "Already reported done; ending.", calls: [] };
  }
  const done = answers.done?.noul ?? 0;
  const next = answers.next_action?.choice ?? "other";
  const agentType = answers.worker_agent?.choice === "other" ? "worker" : answers.worker_agent?.choice ?? "worker";
  const goal = resolveGoal(req.events);
  const { spawned, childId } = spawnState(req.events);

  if (done >= 0.5 || next === "report_done") {
    return {
      terminal: true,
      say: `Goal complete: ${goal.slice(0, 200)}`,
      calls: [
        {
          tool: "subagent_done",
          args: { result: `Decision run finished (jev: done=${done.toFixed(2)}, next=${next}).` },
          reason: "jev judged the goal achieved",
        },
      ],
    };
  }
  if (next === "spawn_worker" && !spawned) {
    return {
      say: `Spawning a ${agentType} for the goal.`,
      calls: [
        {
          tool: "subagent",
          args: { name: "Goal worker", agent: agentType, task: goal.slice(0, 2000), cwd: req.agent?.cwd ?? process.cwd() },
          reason: `jev selected spawn_worker/${agentType}`,
        },
      ],
    };
  }
  if (next === "check_in" && spawned) {
    return {
      say: "Checking in on the running worker.",
      calls: [
        {
          tool: "subagent_message",
          args: {
            ...(childId ? { id: childId } : { name: "Goal worker" }),
            message: "Status check: how is the task going?",
          },
          reason: "jev selected check_in",
        },
      ],
    };
  }
  // wait, or unmappable answers: end the turn without calls; child completion wakes the loop.
  return {
    say: next === "wait" ? "Waiting for the running worker." : `Holding (jev: next=${next}).`,
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
