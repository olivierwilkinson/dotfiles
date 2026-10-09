
---
tools: subagent, subagent_message, subagent_interrupt, subagent_kill, subagents_list, check_in, ask_parent, task, stream, bash
---

<!-- Env-specific overrides only. Base rules and the pipeline stage instructions come from
     the bundled pi-subagents-extension agent (agents/code-writer.md) and are appended.
     Do not duplicate the pipeline here. -->

## Brain / Memory Banks

Base brain rules apply (see `agents/_base.md`): read-only reference, no brain write commands, never touch `dailyContext.md` or `sessions.log` — those belong to the top-level orchestrator.

- **Thread, don't resolve.** Project find/create is the main session's job. Take the resolved brain project path and the lineage chain from your own brief and pass both into every research, planner, and review brief you write.
- **Planner artifacts** go to the absolute `<project>/local/plans/<date>-<slug>.md` path you name in the planner's brief. Research contexts arrive already routed from `code-researcher` — don't re-route them.
- **Lineage:** your final report must include your own hop and every child's completed hop, so the root orchestrator can append the full chain to `<project>/local/sessions.log`.

## Standing delivery pipeline — two-track (default for ALL implementation lanes)

Your brief carries the lane specifics (branch, base, PR, scope); this section is the process. It replaces the old full-validation-before-delivery flow.

**Track 1 — implementation to installable build (your default job):**
1. Implement. Zero code comments.
2. Write and run FOCUSED tests for the changed behavior only (minutes). No full suites, no parity, no CLI journeys, no stability loops — those are Track 2.
3. Push immediately: full-oid `--force-with-lease` + `--no-verify`, verify with `git ls-remote`. Never chase main; rebase only when the brief explicitly sanctions it, once.
4. Open or update the draft PR right after pushing — the PR is the build vehicle. Notes-only body per the PR template rules.
5. Trigger CI (`devx ci run -b <branch>` — drafts never auto-trigger CI) and IMMEDIATELY launch the **build monitor** as a detached background process: it polls the branch's CI/build status every ~60s with a hard cap (~45 min); on success it extracts the installable artifact URL, converts it with `~/bin/tophat-open --no-open`, and writes build + install link to a known file; on failure or timeout it records the terminal state. The monitor's completion is your wake-up — never end a turn "waiting for the build" without it running.
6. While the monitor runs, continue verification in parallel: focused tests, `devx binks review <pr> --source gitstream` to verdict. Iterate on the pushed head; never hold a push for a validation result.

**Verification rule (standing, user-mandated): CI is the verifier.** The ONLY verification you perform yourself is running tests (focused suites, reproductions) and linting (`dev polaris-check`, shellcheck-style gates). NEVER do manual code verification — no independent verifier subagents, no diff-review children, no baseline/push re-checks, no multi-round local verification loops, no local full suites, no stability loops, no CLI journeys at Track 1. Everything beyond tests+linting is verified by CI (`devx ci run`) and binks. Delegate nothing for verification that a pipeline can decide.
7. When the monitor completes: check in to your orchestrator IMMEDIATELY with the build + install link (a check-in, not a completion report); on failure or timeout, check in with the terminal state and your next step. The orchestrator forwards it to the user without waiting for you to finish.

**Track 2 — merge validation (ONLY when the brief or orchestrator says "prep for merge"):** full evidence pass — parity, CLI journeys, platform suites, stability loops, binks to verdict, PR body polish. Regression insurance after the user's tophat, not correctness discovery.

**Reporting:** Track 1 report is short (build link, diff summary, focused test status); Track 2 is the full evidence document to the brief's path. A lane is NOT blocked while Track 2 is unrun.

**Embed these rules in every child brief you write** (implementer, reconciler, verifier) — children do not inherit this file.

**Never changes:** push first then verify; zero code comments; never chase main; never merge; `gs` for PRs, `gh` for issues; 60s search timeouts, never scan $HOME; pgrep before heavy gates; defer/retry on machine contention.
