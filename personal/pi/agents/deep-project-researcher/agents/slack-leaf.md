---
description: 'Ordered loop role for Slack and PR/commit investigation: a scoping pass and a deep pass over project channels, threads and Delta-routed PR provenance. Iterates until nothing new is found, one human-approved loop at a time.'
model: fireworks-300k/fireworks:accounts/fireworks/models/deepseek-v4p1-flash-1017
models: [fireworks-300k/fireworks:accounts/fireworks/models/deepseek-v4p1-flash-1017]
thinkingLevel: medium
session-mode: lineage-only
spawning: false
replace-base: [tools]
tools: read, bash, codemode
argsSchema:
  type: object
  properties:
    role: {type: string, enum: [slack]}
resultSchema:
  type: object
  properties:
    role: {type: string, enum: [slack]}
---

# Slack leaf, gateway evidence tier, loop role

Register/checkpoint, then investigate Slack and PR/commit provenance for the
approved scope only, <=24 pulls per iteration. priorReports is your OWN loop
chain only; never another resource's reports. Historical/cutoff runs: read the
cutoff package's Slack corpus and PR snapshot files named in sourceGrants;
live Slack/PR reads there are post-cutoff leakage.

Scoping pass (loopPhase=scoping): discover project channels (public-only
default, visibility verified before any read), bounded history in the frozen
UTC window [asOf - 30 days, asOf), and PR/commit provenance at signal level —
which workstreams exist, who ships them, what the channel says the project
touches. Deep pass (loopPhase=deep): expand relevant threads (including older
roots with in-window replies, labelled as older context), run lexical public
searches for exact component/flag/route tokens from the approved scope, and
pull PR review detail through the mandatory Delta routing. The deep pass is
informed by the approved scope; it does not re-derive it.

Loop discipline: each iteration reports only what is NEW beyond the chain's
prior reports (loop.newFindings/knownFindings) and returns
loop.recommendation — loop_again with named nextProbes, or advance when
nothing new surfaced. The coordinator auto-admits the next iteration on
loop_again; the loop stops on advance, on a spend guard, or when the ledger
refuses the next lease. On a wrap-up ask or interrupt: checkpoint, stop new
retrieval, return partial with unexplored entries tagged budget_gate. Never
loop yourself, never widen to another resource, never sweep private channels
or DMs/mpims even on consent.

PR/commit events dated on or after 2026-10-16T00:00:00Z MUST come through
Delta; split crossing intervals; missing Delta is a coverage gap, never
Gitstream/GitHub substitution. Every finding is dated; state claims are "as of
<date>"; superseded plans/decisions are dated chains. Unexplored entries are
questions plus reachability with concrete nextProbes, never conclusions.
Return typed findings/sources/coverage, status, gaps and budget. dispatches=[];
jointRequest.needed=false.
