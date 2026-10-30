#!/usr/bin/env python3
"""DPR admission/checkpoint ledger, not a provider billing or tool-call sandbox.

Only reads explicitly registered Pi session JSONL files. Persisted assistant
usage.cost.total is summed once per session; no rolled-up child cost is added.
All mutations share flock + atomic replace. CLI callers must be registered.
"""
import argparse
from contextlib import contextmanager
from decimal import Decimal
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time

# Second scope admission is reserved for parent-directed revision cycles
# (e.g. a pipeline change requiring the assembler to re-derive its interests
# manifest); the normal flow still admits scope exactly once.
ROLES = {"scope": 2, "decomposition": 1, "vault": None, "slack": None,
         "code_sweep": None, "facet": None, "enumerate": None, "synthesis": 2,
         "joint": 1, "think": 3}
LOOP_ROLES = {"vault", "slack", "code_sweep", "facet", "enumerate"}
MAX_SESSION_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


def money(value):
    n = Decimal(str(value))
    if not n.is_finite() or n < 0:
        raise ValueError("invalid USD amount")
    return n


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Ledger:
    def __init__(self, path, session_root):
        self.path = Path(path)
        self.session_root = Path(session_root).resolve()

    def session(self, path):
        p = Path(path)
        if not p.is_absolute():
            raise ValueError("session path must be absolute")
        p = p.resolve(strict=True)
        if not p.is_relative_to(self.session_root) or not p.is_file() or p.suffix != ".jsonl":
            raise ValueError("session must be an existing JSONL under Pi sessions")
        return str(p)

    @contextmanager
    def transaction(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.with_suffix(".lock").open("a") as lock:
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ValueError("ledger lock unavailable; fail closed")
                    time.sleep(0.02)
            try:
                state = json.loads(self.path.read_text()) if self.path.exists() else None
                yield state
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def save(self, state):
        fd, name = tempfile.mkstemp(prefix=".dpr-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as out:
                json.dump(state, out, indent=2, allow_nan=False)
                out.write("\n")
                out.flush()
                os.fsync(out.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def init(self, run_id, actor):
        actor = self.session(actor)
        with self.transaction() as state:
            if state is not None:
                self.owner(state, actor)
                if state["runId"] != run_id:
                    raise ValueError("run identity mismatch")
                return state
            state = {"version": 1, "runId": run_id, "coordinator": actor,
                     "nextThresholdUsd": 100, "pendingGate": None, "approvals": [],
                     "scope": None, "admissions": {},
                     "sessions": {actor: {"ticket": "coordinator", "usd": "0", "bytes": 0}}}
            self.save(state)
            return state

    @staticmethod
    def owner(state, actor):
        if state["coordinator"] != actor:
            raise ValueError("coordinator-only operation")

    def refresh(self, state, verify_scope=True):
        if verify_scope and state["scope"] and digest(state["scope"]["path"]) != state["scope"]["digest"]:
            raise ValueError("scope artifact changed; parent must supply a newly bound revision")
        total = Decimal(0)
        total_bytes = 0
        for path, receipt in state["sessions"].items():
            session_path = Path(self.session(path))
            size = session_path.stat().st_size
            total_bytes += size
            if size > MAX_SESSION_BYTES or total_bytes > MAX_TOTAL_BYTES:
                raise ValueError("session read ceiling; ask parent, do not omit costs")
            with session_path.open("rb") as source:
                raw = source.read(size)
            if len(raw) != size:
                raise ValueError("session changed during read; retry checkpoint")
            if len(raw) < receipt["bytes"]:
                raise ValueError("session truncated; spend unavailable")
            if raw and not raw.endswith(b"\n"):
                raise ValueError("partial JSONL append; retry checkpoint, never assume zero")
            seen = set()
            usd = Decimal(0)
            for line in raw.splitlines():
                entry = json.loads(line)
                message = entry.get("message", {})
                if entry.get("type") != "message" or message.get("role") != "assistant":
                    continue
                entry_id = entry.get("id")
                if not isinstance(entry_id, str) or entry_id in seen:
                    raise ValueError("missing/duplicate assistant entry identity")
                seen.add(entry_id)
                usage = message.get("usage", {})
                cost = usage.get("cost", {}).get("total")
                if not isinstance(cost, (int, float)) or isinstance(cost, bool) or not math.isfinite(cost):
                    raise ValueError("unpriced assistant usage; ask parent for priced telemetry")
                amount = money(cost)
                if amount == 0 and any(usage.get(k, 0) > 0 for k in ("input", "output", "cacheRead", "cacheWrite")):
                    raise ValueError("zero-priced token usage; spend is unknown, not free")
                usd += amount
            if usd < money(receipt["usd"]):
                raise ValueError("session spend decreased; fail closed")
            receipt.update(usd=str(usd), bytes=len(raw))
            total += usd
        state["usedUsd"] = str(total)
        state["sampledAt"] = time.time()
        if total >= money(state["nextThresholdUsd"]) and state["pendingGate"] is None:
            state["pendingGate"] = {"thresholdUsd": state["nextThresholdUsd"], "reason": "observed_spend"}
        return total

    @staticmethod
    def outstanding(state):
        result = Decimal(0)
        for key, admission in state["admissions"].items():
            if admission["settled"]:
                continue
            spent = sum((money(s["usd"]) for s in state["sessions"].values() if s["ticket"] == key), Decimal(0))
            result += max(Decimal(0), money(admission["leaseUsd"]) - spent)
        return result

    def run(self, op, actor, **args):
        actor = self.session(actor)
        with self.transaction() as state:
            if not state or state.get("version") != 1 or actor not in state["sessions"]:
                raise ValueError("unknown/corrupt run or unregistered caller")
            used = self.refresh(state, verify_scope=op != "scope")
            response = {"ok": True}
            if op == "scope":
                self.owner(state, actor)
                scope_digest = digest(args["scope_file"])
                state["scope"] = {"digest": scope_digest, "path": str(Path(args["scope_file"]).resolve()),
                                  "approved": False, "approvalRef": None}
                response["scopeDigest"] = scope_digest
            elif op == "approve-scope":
                self.owner(state, actor)
                if not state["scope"] or state["scope"]["digest"] != args["scope_digest"]:
                    raise ValueError("stale scope approval")
                if not args["approval_ref"].strip():
                    raise ValueError("approval evidence required")
                state["scope"].update(approved=True, approvalRef=args["approval_ref"])
            elif op == "request-gate":
                self.owner(state, actor)
                state["pendingGate"] = state["pendingGate"] or {
                    "thresholdUsd": state["nextThresholdUsd"], "reason": "insufficient_lease_headroom"}
            elif op == "approve-cost":
                self.owner(state, actor)
                gate = state["pendingGate"]
                if not gate or gate["thresholdUsd"] != args["threshold"] or not args["approval_ref"].strip():
                    raise ValueError("approval must match exactly one pending $100 checkpoint")
                state["approvals"].append({**gate, "approvalRef": args["approval_ref"], "usedUsd": str(used)})
                state["nextThresholdUsd"] += 100
                state["pendingGate"] = None
                if used >= money(state["nextThresholdUsd"]):
                    state["pendingGate"] = {"thresholdUsd": state["nextThresholdUsd"], "reason": "observed_spend"}
            elif op == "admit":
                self.owner(state, actor)
                role, key = args["role"], args["key"]
                lease = money(args["lease_usd"])
                phase = args.get("loop_phase")
                if role not in ROLES or not 0 < lease <= 10 or not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", key):
                    raise ValueError("invalid role, ticket key or lease (0 < USD <= 10)")
                if role in LOOP_ROLES and phase not in ("scoping", "deep"):
                    raise ValueError("loop roles require loop_phase scoping|deep")
                if role not in LOOP_ROLES and phase is not None:
                    raise ValueError("loop_phase is only valid for loop roles")
                if role == "code_sweep" and phase != "scoping":
                    raise ValueError("code_sweep is scoping-phase only")
                if role == "facet" and phase != "deep":
                    raise ValueError("facet loops are deep-phase only")
                if role == "enumerate" and phase != "deep":
                    raise ValueError("enumerate loops are deep-phase only")
                old = state["admissions"].get(key)
                if old:
                    if old["role"] != role or money(old["leaseUsd"]) != lease or old.get("phase") != phase:
                        raise ValueError("ticket identity conflict")
                    response.update(ticket=key, replay=True)
                elif state["pendingGate"]:
                    response.update(ok=False, reason="cost_gate_pending")
                elif role != "scope" and not (role in LOOP_ROLES and phase == "scoping") and \
                        (not state["scope"] or not state["scope"]["approved"] or
                         state["scope"]["digest"] != args.get("scope_digest")):
                    response.update(ok=False, reason="scope_not_approved")
                elif ROLES[role] is not None and sum(a["role"] == role for a in state["admissions"].values()) >= ROLES[role]:
                    response.update(ok=False, reason="role_lifetime_cap")
                elif sum(not a["settled"] for a in state["admissions"].values()) >= 3:
                    response.update(ok=False, reason="concurrency_cap")
                elif used + self.outstanding(state) + lease >= money(state["nextThresholdUsd"]):
                    response.update(ok=False, reason="lease_headroom", hint="reduce lease or request early cost gate")
                else:
                    state["admissions"][key] = {"role": role, "leaseUsd": str(lease), "session": None,
                                                "scopeDigest": args.get("scope_digest"), "phase": phase,
                                                "settled": False}
                    response["ticket"] = key
            elif op == "settle":
                key = args["key"]
                admission = state["admissions"][key]
                if actor != state["coordinator"] and admission["session"] != actor:
                    raise ValueError("cannot settle another leaf")
                if not args["completion_ref"].strip():
                    raise ValueError("completion/failure evidence required")
                admission.update(settled=True, completionRef=args["completion_ref"])
            elif op != "checkpoint":
                raise ValueError("unknown operation")
            mine = state["sessions"][actor]
            lease_exhausted = False
            if mine["ticket"] != "coordinator":
                admission = state["admissions"][mine["ticket"]]
                lease_exhausted = money(mine["usd"]) >= money(admission["leaseUsd"])
                if admission["settled"]:
                    lease_exhausted = True
            scope_valid = True
            if mine["ticket"] != "coordinator":
                admission = state["admissions"][mine["ticket"]]
                if admission["role"] != "scope" and admission.get("phase") != "scoping":
                    scope_valid = bool(state["scope"] and state["scope"]["approved"] and
                                       state["scope"]["digest"] == admission["scopeDigest"])
            response.update(runId=state["runId"], usedUsd=str(used),
                            sessions=[{"ticket": s["ticket"], "session": path, "usd": s["usd"]}
                                      for path, s in state["sessions"].items()],
                            reservedUsd=str(self.outstanding(state)), nextThresholdUsd=state["nextThresholdUsd"],
                            pendingGate=state["pendingGate"], leaseExhausted=lease_exhausted,
                            mayRetrieve=not state["pendingGate"] and not lease_exhausted and scope_valid)
            self.save(state)
            return response

    def register(self, ticket, actor):
        actor = self.session(actor)
        with self.transaction() as state:
            if not state or ticket not in state["admissions"]:
                raise ValueError("unknown ticket")
            admission = state["admissions"][ticket]
            if admission["settled"] or admission["session"] not in (None, actor):
                raise ValueError("settled or already bound ticket")
            if actor in state["sessions"] and state["sessions"][actor]["ticket"] != ticket:
                raise ValueError("session already counted under another ticket")
            admission["session"] = actor
            state["sessions"].setdefault(actor, {"ticket": ticket, "usd": "0", "bytes": 0})
            self.refresh(state)
            self.save(state)
        return self.run("checkpoint", actor)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("op", choices=["init", "register", "checkpoint", "scope", "approve-scope", "admit",
                                  "settle", "request-gate", "approve-cost"])
    p.add_argument("--ledger", required=True)
    p.add_argument("--run-id")
    p.add_argument("--key")
    p.add_argument("--role", choices=list(ROLES))
    p.add_argument("--loop-phase", choices=["scoping", "deep"])
    p.add_argument("--lease-usd", type=str)
    p.add_argument("--scope-file")
    p.add_argument("--scope-digest")
    p.add_argument("--approval-ref")
    p.add_argument("--threshold", type=int)
    p.add_argument("--completion-ref")
    args = vars(p.parse_args())
    op = args.pop("op")
    path = Path(args.pop("ledger")).expanduser()
    root = Path.home() / ".pi/agent/dpr-runs"
    if not path.is_absolute() or path.parent.resolve() != root.resolve() or not re.fullmatch(r"[A-Za-z0-9_-]+\.json", path.name):
        raise ValueError("ledger must be ~/.pi/agent/dpr-runs/<runId>.json")
    if path.is_symlink() or path.with_suffix(".lock").is_symlink():
        raise ValueError("ledger/lock symlink refused")
    actor = os.environ.get("PI_SUBAGENT_SESSION") or os.environ.get("PI_SESSION_FILE")
    if not actor:
        raise ValueError("Pi session identity unavailable")
    ledger = Ledger(path, Path.home() / ".pi/agent/sessions")
    needed = {"init": ["run_id"], "register": ["key"], "scope": ["scope_file"],
              "approve-scope": ["scope_digest", "approval_ref"],
              "admit": ["role", "key", "lease_usd"], "settle": ["key", "completion_ref"],
              "approve-cost": ["threshold", "approval_ref"]}
    if any(args.get(k) is None for k in needed.get(op, [])):
        raise ValueError("missing operation arguments")
    if op == "init":
        if path.stem != args["run_id"]:
            raise ValueError("runId must match ledger basename")
        ledger.init(args["run_id"], actor)
        result = ledger.run("checkpoint", actor)
    elif op == "register":
        result = ledger.register(args["key"], actor)
    else:
        result = ledger.run(op, actor, **args)
    print(json.dumps(result))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError, ArithmeticError) as error:
        print(json.dumps({"ok": False, "reason": "ledger_unavailable", "error": str(error)}))
        sys.exit(2)
