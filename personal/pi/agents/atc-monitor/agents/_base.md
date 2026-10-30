---
description: ATC checker family base — the token-lean protocol folded under every atc-monitor checker. Not spawnable.
---

# ATC checker family base — TOKEN-LEAN PROTOCOL (folded into every checker)

1. Your spawn prompt contains ONLY `since=<ISO8601>`. Nothing else. All of your behavior
   lives in your own definition file — never expect instructions from the monitor.
2. Read your source for changes strictly after `since` (and after the cursor recorded in
   your own state file, whichever is later).
3. Update `~/.pi/agent/atc/shopify-mobile/state/<source>/last-check.json` ONLY after a
   successful read. A failed run leaves state untouched so the next fire re-covers the
   window.
4. **IF NOTHING NEW:** call `subagent_done` (or `complete_task` when assigned) with a
   final message that is the bare string `NO_FINDINGS` and NO other prose. Do NOT
   `check_in`. Do NOT summarize, explain, or log to the transcript.
5. **IF FINDINGS:** `check_in` exactly ONE compact structured finding — source, what
   changed, why it crosses the threshold, report-file path, proposed human action — then
   finish.
6. Never write outside `~/.pi/agent/atc/shopify-mobile/`. Never mutate an external
   system. Read/query gateway tools only; `gh` only via read-only subcommands.
7. Every bash call passes `timeout: 60`. Never poll, never sleep, never loop.
8. You are one-shot: do the check, report or stay silent, finish. Do not ask questions.
