# Helix agent-pack trim analysis (2026-09-11)

Scope: /Users/olivier/.pi/agent/agents/helix/{agent.md,agents/*.md} vs
skills/helix/SKILL.md, prompts/adversarial-review.md, skills/agent-device/SKILL.md.

## agent.md (orchestrator) — 458 lines

Composition: ~55% orchestration-specific (stage roster/briefing contract, spawn/resume
lifetimes, gate batching via gates.md, ask_parent gate table, fallback/degradation matrix,
stage graph, the subagent-is-main-session override). ~40% skill repetition. ~5% mixed.

Duplicated blocks (would drift when SKILL.md changes):
- §2 memory rules (≤20 lines, sole writer, remove-when-stale) restates SKILL "Memory".
- §5 step 2 device-gate loop restates SKILL step 6 (INVALID semantics, debug-pill round-trip,
  "comparable visual scenario" rule) — mostly necessary as sequencing, but verdict semantics
  (INVALID = capture wrong, recapture, never argue) duplicate the skill verbatim.
- §5 step 3 freeze/re-review rules restate SKILL step 7 (union merge, stricter verdict,
  focused re-review, APPROVE WITH CHANGES not approval) nearly verbatim.
- §5 step 4 prune rules, step 6 commit rules (scratch-file scan, artifacts incl.
  checkpoints.md/test-cases.md) duplicate SKILL steps 8–9.
- §7 gates table restates SKILL Done-when and step-6/7 details (unscoped final review,
  mixed-references two-run rule, sheet-canvas note).
- §8 gate table content (branch approval, scope decisions, device confirmation) restates
  Setup 1–4; the required-content column is orchestration, the trigger column is skill.
- §10 Done-when list is a near-verbatim copy of SKILL "Done when" (incl. cli-test final gate,
  ios/.build cleanup, artifact-deletion-as-own-commit).
- §6 autonomous mode restates SKILL "Working with the human" almost fully.
- §9 fallbacks restate SKILL step-7 fallback semantics (fresh pair, previous-response handoff,
  non-zero exit = failed gate).

Must stay: zone-root pinning, the subagent-per-stage override, briefing contract, stage
lifetimes/resume map, gates.md batching (8b is genuinely new orchestration policy), ask_parent
gate table (when/how to surface), stage graph, compact-tip-as-last-line (messaging detail),
"reviewer briefs carry no diff" (brief mechanics).

Trim: cut §10 to a pointer ("verify every [SKILL] §Done when bullet; report per-bullet"),
cut the duplicated semantics in §5 keeping only who-executes-when and routing, shrink §7 to
the orchestration-only columns, compress §6 and §9 to a few bullets each, drop memory-rule
details to a pointer. Estimated: 458 → ~230–260 lines.

## device-setup.md — 115 lines

Composition: ~30% orchestration (two-phase DISCOVER/VERIFY split, gate dependency, reporting
contract, never-contact-human). ~65% skill repetition: the entire Setup 4/5 body (bundle-id
tables, session naming/topology, Polaris legacy-light check, no-Metro, isolation paths,
dev cli do Login/dump sequence, 6-second timeout, TEST_ACCOUNT_ARGS remote fallback, --plain
never --interactive, exit CLI when done) is a close paraphrase of SKILL.md Setup 4–5, and the
session-naming rule duplicates agent-device/SKILL.md.

Must stay: the two-phase split and what triggers VERIFY, load-list (it already points at the
skill files), reporting contract (exact fields to return: package ids, session names, blocker).

Trim: replace the Setup 4/5 bodies with "execute [SKILL] Setup 4–5 per
skills/agent-device/SKILL.md" + keep phase semantics and the report schema. Estimated: 115 →
~55 lines.

## checkpoint-implementer.md — 260 lines

Composition: ~25% orchestration (phase model SETUP-PREP / PLAN-CHECKPOINTS / IMPLEMENT / FIX /
FINALIZE / COMMIT, load-order, reporting, never-commit-before-approval). ~70% repetition:
- Standing rules duplicate SKILL's intro nearly verbatim (implement-everything, pull-to-refresh,
  sheet-canvas divergence incl. PolarisSheet detent detail, no-compat-layers, @Synchronized).
- checkpoints.md format (≤10, 100-word summary, 300-char bullets, skeleton-first, status in
  heading, state-with-checkpoint) duplicates SKILL "Plan checkpoints" incl. the markdown example.
- Implement 1–5 bodies duplicate SKILL (actions-are-merchant-surface, Mockable/MockK, surgical
  test runs, never hand-edit Polaris, dev gql note, build paths).
- FINALIZE prune rules and COMMIT scratch-scan rules duplicate SKILL steps 8–9.

Must stay: phase names and their human-gate dependencies, absolute-path load list, the
reporting contract (changed-file list for focused re-review), "never create branch / commit
without helix's relay".

Trim: replace standing-rules and step bodies with the skill pointer (the load-list already
names SKILL.md, AGENTS.md, graphql, swift-unit-testing, cli-test, view-layer,
polaris-components — the content is loaded anyway); keep only phase semantics + Helix-specific
offsets (do-not-pass --remote for ViewModel step is already in the skill; drop). Keep a very
short "orchestration constraints" block. Estimated: 260 → ~90–110 lines.

## test-kit-writer.md — 73 lines

Composition: ~35% orchestration (async spawn timing, one-file-only boundary, reporting).
~60% repetition: persona, selection rules (bang-for-buck, sampled-vs-features, no logout/cache
cases, legacy-RN-light-only, CLI-verifiable cases, capturable visual scenarios) all restate
SKILL "Build the test kit" nearly line-for-line.

Must stay: async timing, output path + pure-checklist contract, boundaries (never touch
checkpoints.md/memory/source), reporting.

Trim: point at SKILL "Build the test kit" + "Plan checkpoints" (already in load list); keep
~35–40 lines.

## ui-review-runner.md — 134 lines

Composition: ~20% orchestration (session ownership, resumed-per-checkpoint lifetime, close-out
invocation, reporting, never-edit-source). ~75% repetition: the Device-gate sweep section
(capture rules, scroll-to-bottom, debug-pill handling, entry points, reference-data rules,
CLI shortcut) and the whole gate section (batch concurrency, scoping notes, sheet-canvas note
verbatim, exit codes, INVALID semantics, comparable-visual-scenario rule, unscoped final,
mixed references) restate SKILL step 6 at length; session-naming/isolation duplicates
agent-device SKILL.

Must stay: session-ownership contract (reconnect, replace-only-if-unhealthy + report,
foreground-not-relaunch — foreground is in SKILL too but ownership/resume is not), load list,
close-out invocation, reporting schema, the "one file you edit is test-cases.md" boundary.

Trim: replace the sweep + gate bodies with "execute [SKILL] step 6 exactly per this
checkpoint's test-cases.md group" — keep session ownership, batching reminder, escalation rule.
Estimated: 134 → ~60 lines.

## adversarial-reviewer.md — 96 lines

Composition: ~50% orchestration (context isolation, both-must-APPROVE gate, lane isolation,
focused re-review lane mechanics, boundaries, no-persistence rule). ~45% repetition: the
Load-section skill/doc enumeration duplicates prompts/adversarial-review.md §Derive your own
criteria (which already instructs deriving the checklist from AGENTS.md ToC + governing
skills); review-scope bullets (diff HEAD, untracked status, checkpoints.md-as-scope-record,
accepted-decisions settled) restate SKILL step 7 and the prompt file; the Output section
restates the prompt's output contract (4 sections, verdict line) — though it omits the JSON
block, which the prompt owns.

Must stay: isolation contract, load-list header (paths are useful, but could be one line:
"the prompt file + SKILL step 7 + AGENTS.md"), focused re-review lane mechanics, hard
boundaries, "reviewer response never persisted".

Trim: cut the Output section (prompt file governs) and the derived-checklist enumeration;
keep scope + boundaries + isolation. Estimated: 96 → ~55 lines.

## Risks of trimming

- Runtime access: verified all five stage agents have `read` and the briefs already pin cwd to
  the zone root; every cut block lives in a file named by absolute path in the agent's load
  list (skills/helix/SKILL.md, agent-device/SKILL.md, prompts/adversarial-review.md), so a
  "load then follow" pointer is safe. device-setup and ui-review-runner have
  `read, bash` / `read, write, edit, bash` — both can read the skills.
- Weakest readers run the two device stages (glm-5p3-flash). Risk: an indirection miss ("read
  the skill" skipped under compaction). Mitigate by keeping the hard sequence rules inline
  (phase split, stop conditions, INVALID→escalate, never contact human) even where details
  move to the skill.
- Orchestration-only rules that exist NOWHERE in the skill must not be cut: gates.md batching
  (§8b), subagent-is-main-session override, briefing contract, resume/lifetime map, compact-tip
  placement, consolidated-ruling timing, reviewer-response non-persistence (the prompt file
  does not say it — keep in adversarial-reviewer).
- The orchestrator's gates tables (§7/§8) mix skill semantics with surface mechanics; trim only
  the semantic columns, keep the trigger/surface mechanics.
- skill drift actually helps here: post-trim, SKILL.md edits take effect without editing the
  pack — the current duplication is the drift hazard (e.g. the sheet-canvas note appears
  verbatim in 4 files; the PR #1313-style fixes would need 4 edits).

## Verdict

Roughly half the 1,136-line pack is skill-content repetition; the orchestrator is ~40%
repetition and the stage agents range from ~45% (adversarial-reviewer) to ~75%
(ui-review-runner). Trim plan: keep all spawn/resume/phase/gate-surface/reporting mechanics,
replace every restated skill body with an absolute-path load pointer the files already carry.
Estimated pack: 1,136 → ~520–570 lines (agent.md ~240, implementer ~100, ui-review-runner ~60,
device-setup ~55, adversarial-reviewer ~55, test-kit-writer ~38).
