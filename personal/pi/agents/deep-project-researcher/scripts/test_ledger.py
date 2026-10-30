"""Synthetic offline checks only: no live sessions, source retrieval or agents."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest

from ledger import Ledger, digest


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sessions = self.root / "sessions"
        self.sessions.mkdir()
        self.coordinator = self.session("coordinator", 1)
        self.ledger = Ledger(self.root / "runs/run.json", self.sessions)
        self.ledger.init("run", self.coordinator)
        self.scope = self.root / "scope.md"
        self.scope.write_text("approved public-only scope\n")
        self.hash = self.call("scope", scope_file=str(self.scope))["scopeDigest"]
        self.call("approve-scope", scope_digest=self.hash, approval_ref="human:scope-1")

    def session(self, name, usd):
        path = self.sessions / (name + ".jsonl")
        path.write_text("")
        self.append(path, usd)
        return str(path)

    def append(self, path, usd):
        path = Path(path)
        count = len(path.read_text().splitlines())
        entry = {"type": "message", "id": str(count),
                 "message": {"role": "assistant", "usage": {"input": 1, "cost": {"total": usd}}}}
        with path.open("a") as out:
            out.write(json.dumps(entry) + "\n")

    def call(self, op, **args):
        return self.ledger.run(op, self.coordinator, **args)

    def admit(self, key="facet-1", role="facet", lease=5):
        phase = "deep" if role in ("facet", "enumerate") else None
        return self.call("admit", key=key, role=role, lease_usd=lease,
                         scope_digest=self.hash, loop_phase=phase)

    def test_deep_requires_scope_gate(self):
        self.call("scope", scope_file=str(self.scope))
        result = self.admit()
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "scope_not_approved")
        self.assertTrue(self.admit("scope-1", "scope")["ok"])

    def test_stale_approval_and_changed_artifact(self):
        with self.assertRaisesRegex(ValueError, "stale scope"):
            self.call("approve-scope", scope_digest="wrong", approval_ref="human:x")
        self.scope.write_text("changed private scope")
        with self.assertRaisesRegex(ValueError, "artifact changed"):
            self.admit()
        new_hash = self.call("scope", scope_file=str(self.scope))["scopeDigest"]
        self.assertNotEqual(self.hash, new_hash)
        self.assertFalse(self.admit()["ok"])

    def test_unique_sessions_no_double_count_and_settle_retains_cost(self):
        self.admit()
        child = self.session("leaf", 2)
        result = self.ledger.register("facet-1", child)
        self.assertEqual(float(result["usedUsd"]), 3)
        self.assertEqual(float(self.call("checkpoint")["usedUsd"]), 3)
        self.call("settle", key="facet-1", completion_ref="report:1")
        self.append(child, 0.5)  # completion formatting after last leaf checkpoint
        result = self.call("checkpoint")
        self.assertEqual(float(result["usedUsd"]), 3.5)
        self.assertEqual(float(result["reservedUsd"]), 0)

    def test_registration_cannot_rebind_or_duplicate_session(self):
        self.admit()
        leaf = self.session("one", 1)
        self.ledger.register("facet-1", leaf)
        with self.assertRaisesRegex(ValueError, "already bound"):
            self.ledger.register("facet-1", self.session("two", 1))
        self.admit("facet-2")
        with self.assertRaisesRegex(ValueError, "another ticket"):
            self.ledger.register("facet-2", leaf)

    def test_gate_at_100_and_200_and_no_spawn_admission_pending(self):
        self.append(self.coordinator, 99)
        result = self.call("checkpoint")
        self.assertEqual(result["pendingGate"]["thresholdUsd"], 100)
        self.assertFalse(self.admit()["ok"])
        self.call("approve-cost", threshold=100, approval_ref="parent:100")
        self.append(self.coordinator, 100)
        result = self.call("checkpoint")
        self.assertEqual(result["pendingGate"]["thresholdUsd"], 200)
        self.assertFalse(self.admit()["ok"])
        self.call("approve-cost", threshold=200, approval_ref="parent:200")
        self.assertTrue(self.admit()["ok"])

    def test_overshoot_requires_each_threshold(self):
        self.append(self.coordinator, 249)
        self.assertEqual(self.call("checkpoint")["pendingGate"]["thresholdUsd"], 100)
        self.assertEqual(self.call("approve-cost", threshold=100, approval_ref="parent:100")["pendingGate"]["thresholdUsd"], 200)
        self.assertFalse(self.admit()["ok"])
        result = self.call("approve-cost", threshold=200, approval_ref="parent:200")
        self.assertIsNone(result["pendingGate"])
        self.assertEqual(result["nextThresholdUsd"], 300)

    def test_approval_exact_pending_threshold_with_evidence(self):
        with self.assertRaisesRegex(ValueError, "exactly one pending"):
            self.call("approve-cost", threshold=100, approval_ref="made-up")
        self.call("request-gate")
        for threshold, ref in [(200, "parent:x"), (100, "")]:
            with self.assertRaises(ValueError):
                self.call("approve-cost", threshold=threshold, approval_ref=ref)

    def test_resume_same_ledger_never_resets_spend_or_gates(self):
        self.append(self.coordinator, 99)
        self.call("checkpoint")
        reloaded = Ledger(self.ledger.path, self.sessions)
        reloaded.init("run", self.coordinator)
        result = reloaded.run("checkpoint", self.coordinator)
        self.assertEqual(float(result["usedUsd"]), 100)
        self.assertIsNotNone(result["pendingGate"])
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            reloaded.init("new-run", self.coordinator)
        with self.assertRaisesRegex(ValueError, "coordinator-only"):
            reloaded.init("run", self.session("new-coordinator", 1))

    def test_parallel_admission_is_atomic_and_reserves_headroom(self):
        self.append(self.coordinator, 90)  # 91 used, one $5 lease fits, two do not
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda key: self.admit(key), ["facet-1", "facet-2"]))
        self.assertEqual(sum(r["ok"] for r in results), 1)
        self.assertEqual(float(self.call("checkpoint")["reservedUsd"]), 5)

    def test_lifetime_role_and_concurrency_quotas(self):
        self.assertTrue(self.admit("joint-1", "joint")["ok"])
        self.call("settle", key="joint-1", completion_ref="failed:before-start")
        self.assertEqual(self.admit("joint-2", "joint")["reason"], "role_lifetime_cap")
        for key in ["f1", "f2", "f3"]:
            self.assertTrue(self.admit(key)["ok"])
        self.assertEqual(self.admit("f4")["reason"], "concurrency_cap")

    def test_leaf_checkpoint_stops_on_lease_and_gate(self):
        self.admit()
        leaf = self.session("leaf", 5)
        self.assertFalse(self.ledger.register("facet-1", leaf)["mayRetrieve"])
        self.append(self.coordinator, 94)
        result = self.ledger.run("checkpoint", leaf)
        self.assertFalse(result["mayRetrieve"])
        self.assertIsNotNone(result["pendingGate"])

    def test_scope_invalidation_stops_existing_deep_leaf(self):
        self.admit()
        leaf = self.session("leaf", 1)
        self.ledger.register("facet-1", leaf)
        new_scope = self.root / "revision-2.md"
        new_scope.write_text("revised scope")
        self.call("scope", scope_file=str(new_scope))
        self.assertFalse(self.ledger.run("checkpoint", leaf)["mayRetrieve"])

    def test_unknown_corrupt_partial_zero_pricing_fail_closed(self):
        original = Path(self.coordinator).read_text()
        bad = ["{bad json}\n", '{"type":"message"',
               json.dumps({"type": "message", "id": "x", "message": {"role": "assistant"}}) + "\n",
               json.dumps({"type": "message", "id": "x", "message": {"role": "assistant", "usage": {"input": 1, "cost": {"total": 0}}}}) + "\n"]
        for raw in bad:
            Path(self.coordinator).write_text(original + raw)
            with self.assertRaises((ValueError, KeyError)):
                self.admit()
        Path(self.coordinator).write_text(original)
        self.assertTrue(self.admit()["ok"])

    def test_missing_truncated_and_decreased_usage_fail_closed(self):
        self.call("checkpoint")
        original = Path(self.coordinator).read_text()
        Path(self.coordinator).write_text("")
        with self.assertRaisesRegex(ValueError, "truncated"):
            self.call("checkpoint")
        Path(self.coordinator).write_text(original.replace('"total": 1', '"total": 0.1'))
        with self.assertRaisesRegex(ValueError, "decreased"):
            self.call("checkpoint")
        Path(self.coordinator).unlink()
        with self.assertRaises(OSError):
            self.admit()

    def test_replay_is_not_another_lifetime_slot(self):
        self.admit()
        self.assertTrue(self.admit()["replay"])
        with self.assertRaisesRegex(ValueError, "ticket identity conflict"):
            self.admit(lease=4)
        with self.ledger.transaction() as state:
            self.assertEqual(len(state["admissions"]), 1)

    def test_leaf_cannot_approve_or_settle_another_leaf(self):
        self.admit("f1")
        self.admit("f2")
        leaf = self.session("leaf", 1)
        self.ledger.register("f1", leaf)
        with self.assertRaisesRegex(ValueError, "coordinator-only"):
            self.ledger.run("request-gate", leaf)
        with self.assertRaisesRegex(ValueError, "another leaf"):
            self.ledger.run("settle", leaf, key="f2", completion_ref="fake")

    def test_early_gate_blocks_admission_and_only_advances_one_band(self):
        self.call("request-gate")
        self.assertFalse(self.admit()["ok"])
        result = self.call("approve-cost", threshold=100, approval_ref="parent:early-100")
        self.assertEqual(result["nextThresholdUsd"], 200)

    def test_loop_roles_phase_gated_and_budget_bound(self):
        path = self.root / "runs/run2.json"
        ledger2 = Ledger(path, self.sessions)
        ledger2.init("run2", self.coordinator)
        call = lambda op, **a: ledger2.run(op, self.coordinator, **a)
        # scoping loop admission needs no approved scope artifact
        self.assertTrue(call("admit", key="vault-s1-i1", role="vault", lease_usd=5,
                             loop_phase="scoping")["ok"])
        # a scoping-phase leaf may retrieve without an approved scope
        leaf = self.session("vaultleaf", 0.5)
        self.assertTrue(ledger2.register("vault-s1-i1", leaf)["mayRetrieve"])
        # loop roles require loop_phase; other roles reject it
        with self.assertRaisesRegex(ValueError, "loop_phase"):
            call("admit", key="vault-s1-i2", role="vault", lease_usd=5)
        with self.assertRaisesRegex(ValueError, "loop_phase"):
            call("admit", key="j1", role="joint", lease_usd=5, loop_phase="scoping",
                 scope_digest="x")
        # role/phase pairing: code_sweep scoping-only, facet deep-only
        with self.assertRaisesRegex(ValueError, "scoping-phase only"):
            call("admit", key="sweep-s2-i1", role="code_sweep", lease_usd=5,
                 loop_phase="deep")
        with self.assertRaisesRegex(ValueError, "deep-phase only"):
            call("admit", key="facet-s1-i1", role="facet", lease_usd=5,
                 loop_phase="scoping", scope_digest="x")
        # enumerate: loop role, deep-phase only, no numeric lifetime cap
        with self.assertRaisesRegex(ValueError, "loop_phase"):
            call("admit", key="enum-k1-i1", role="enumerate", lease_usd=3)
        with self.assertRaisesRegex(ValueError, "deep-phase only"):
            call("admit", key="enum-k1-i1", role="enumerate", lease_usd=3,
                 loop_phase="scoping", scope_digest="x")
        # deep-phase loop admission still requires the approved scope
        result = call("admit", key="vault-s2-i1", role="vault", lease_usd=5, loop_phase="deep")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "scope_not_approved")
        # loop roles have no numeric lifetime cap: settled iterations readmit freely
        call("settle", key="vault-s1-i1", completion_ref="report:1")
        for i in range(2, 12):
            self.assertTrue(call("admit", key=f"vault-s1-i{i}", role="vault", lease_usd=1,
                                 loop_phase="scoping")["ok"])
            call("settle", key=f"vault-s1-i{i}", completion_ref=f"report:{i}")
        self.assertEqual(sum(a["role"] == "vault" for a in
                             json.loads(path.read_text())["admissions"].values()), 11)

    def test_facet_loop_admissions_are_budget_bound(self):
        for i in range(1, 8):
            self.assertTrue(self.admit(f"facet-c1-i{i}")["ok"])
            self.call("settle", key=f"facet-c1-i{i}", completion_ref=f"report:{i}")
        state = json.loads((self.root / "runs/run.json").read_text())
        self.assertEqual(sum(a["role"] == "facet" for a in
                             state["admissions"].values()), 7)

    def test_enumerate_loops_deep_only_and_uncapped(self):
        # deep-phase happy path, no numeric lifetime cap, many cells at once
        for cell in ("k1", "k2"):
            for i in range(1, 6):
                self.assertTrue(self.admit(f"enum-{cell}-i{i}", role="enumerate", lease=2)["ok"])
                self.call("settle", key=f"enum-{cell}-i{i}", completion_ref=f"r:{cell}:{i}")
        state = json.loads((self.root / "runs/run.json").read_text())
        self.assertEqual(sum(a["role"] == "enumerate" for a in
                             state["admissions"].values()), 10)

    def test_scope_allows_one_parent_directed_revision(self):
        # (was dead code after the __main__ block with a bad base class; never ran)
        self.assertTrue(self.admit("scope-1", "scope")["ok"])
        self.assertTrue(self.admit("scope-2", "scope")["ok"])
        third = self.admit("scope-3", "scope")
        self.assertFalse(third["ok"])
        self.assertEqual(third["reason"], "role_lifetime_cap")



if __name__ == "__main__":
    unittest.main(verbosity=2)
