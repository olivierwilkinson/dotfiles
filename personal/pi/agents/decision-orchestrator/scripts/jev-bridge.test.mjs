// Bridge-local fold regressions. Run with JEV_SUBAGENTS_PATH pointing at the
// candidate extension's pi-extension/subagents directory, never the installed copy:
// JEV_SUBAGENTS_PATH=/path/to/extension/pi-extension/subagents node --test jev-bridge.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

if (!process.env.JEV_SUBAGENTS_PATH) {
  throw new Error("Set JEV_SUBAGENTS_PATH to the candidate extension; installed fallback forbidden");
}
process.env.JEV_BRIDGE_NO_BOOT = "1";
const { emptyReceipts, foldEvents } = await import("./jev-bridge.mjs");

function fixture(t, state = "killed", recoveryCause) {
  const dir = mkdtempSync(join(tmpdir(), "jev-bridge-fold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, "");
  const receipts = emptyReceipts();
  receipts.lifecycle.old = {
    childId: "old", state, stateTs: 1, name: "Worker", purpose: "work",
    sessionFile, attempt: 1, taskIds: [7],
    ...(recoveryCause ? { recoveryCause } : {}),
  };
  return { dir, sessionFile, receipts };
}

function resume(receipts, sessionPath) {
  return foldEvents(receipts, [
    { type: "decision", calls: [{ id: "resume", tool: "subagent_resume", args: { sessionPath } }] },
    { type: "tool_result", callId: "resume", tool: "subagent_resume", output: "resumed",
      details: { id: "new", status: "started" } },
  ]);
}

function captureWarnings(t) {
  const warnings = [];
  t.mock.method(process.stderr, "write", (message) => { warnings.push(String(message)); return true; });
  return warnings;
}

function loopingPath(dir) {
  const path = join(dir, "loop.jsonl");
  symlinkSync(path, path);
  assert.throws(() => realpathSync(path), { code: "ELOOP" });
  return path;
}

function assertUnmatched(receipts) {
  assert.equal(receipts.lifecycle.new, undefined);
  assert.equal(receipts.lifecycle.old.resumedBy, undefined);
  assert.equal(receipts.operations["control:resume"].effect, undefined);
  assert.equal(receipts.operations["control:resume"].acknowledgement.infraIssue, true);
  assert.match(receipts.operations["control:resume"].acknowledgement.error, /unambiguous lifecycle target/);
}

describe("bridge resume acknowledgement fold", () => {
  for (const [cause, eligible] of [
    ["K1-auth", true], ["K1-provider", true], ["K4", true],
    ["K1-overflow", false], ["K2", false], ["K3", false], [undefined, false],
  ]) {
    it(`killed + ${cause ?? "no cause"} ${eligible ? "resumes" : "cannot resume"}`, (t) => {
      const { receipts, sessionFile } = fixture(t, "killed", cause);
      assert.equal(resume(receipts, sessionFile), true);
      const operation = receipts.operations["control:resume"];
      if (eligible) {
        assert.equal(operation.acknowledgement.infraIssue, undefined);
        assert.equal(operation.effect.childId, "old");
        assert.equal(receipts.lifecycle.old.resumedBy, "new");
        assert.equal(receipts.lifecycle.new.state, "resumed");
        assert.equal(receipts.lifecycle.new.resumedFrom, "old");
        assert.equal(receipts.lifecycle.new.attempt, 2);
        assert.deepEqual(receipts.lifecycle.new.taskIds, [7]);
        const folded = structuredClone(receipts);
        assert.equal(resume(receipts, sessionFile), false, "acknowledgement replay has no effects");
        assert.deepEqual(receipts, folded);
      } else {
        assert.equal(receipts.lifecycle.new, undefined);
        assert.equal(receipts.lifecycle.old.resumedBy, undefined);
        assert.equal(operation.effect, undefined);
        assert.equal(operation.acknowledgement.infraIssue, true);
        assert.match(operation.acknowledgement.error, /eligible old row/);
      }
    });
  }

  it("still matches canonical symlinks for exited-without-done rows", (t) => {
    const { receipts, dir, sessionFile } = fixture(t, "exited-without-done");
    const alias = join(dir, "alias.jsonl");
    symlinkSync(sessionFile, alias);
    resume(receipts, alias);
    assert.equal(receipts.lifecycle.old.resumedBy, "new");
  });

  it("does not guess an unrelated sole exited transcript", (t) => {
    const { receipts, dir } = fixture(t, "exited-without-done");
    resume(receipts, join(dir, "unrelated.jsonl"));
    assertUnmatched(receipts);
  });

  it("notifies and fails closed when the requested path cannot be canonicalized", (t) => {
    const { receipts, dir } = fixture(t, "exited-without-done");
    const path = loopingPath(dir);
    const warnings = captureWarnings(t);
    assert.doesNotThrow(() => resume(receipts, path));
    assertUnmatched(receipts);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /jev-bridge:.*canonical.*ELOOP/);
    assert.ok(warnings[0].includes(path));
  });

  it("skips an unreadable row but still matches another canonical transcript", (t) => {
    const { receipts, dir, sessionFile } = fixture(t, "exited-without-done");
    const path = loopingPath(dir);
    receipts.lifecycle = { bad: { ...receipts.lifecycle.old, childId: "bad", sessionFile: path }, ...receipts.lifecycle };
    const warnings = captureWarnings(t);
    assert.doesNotThrow(() => resume(receipts, sessionFile));
    assert.equal(receipts.lifecycle.bad.resumedBy, undefined);
    assert.equal(receipts.lifecycle.old.resumedBy, "new");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /jev-bridge:.*canonical.*ELOOP/);
  });

  it("never matches two failed canonicalizations, even for identical raw paths", (t) => {
    const { receipts, dir } = fixture(t, "exited-without-done");
    const path = loopingPath(dir);
    receipts.lifecycle.old.sessionFile = path;
    const warnings = captureWarnings(t);
    assert.doesNotThrow(() => resume(receipts, path));
    assertUnmatched(receipts);
    assert.ok(warnings.length > 0);
  });
});
