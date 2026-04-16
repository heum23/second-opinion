// tests/plan-review-args.test.mjs
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, reviewMarkerPath, markReviewCompleted } from "../scripts/plan-review.mjs";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseArgs", () => {
  it("extracts --mode and file paths", () => {
    const result = parseArgs(["node", "plan-review.mjs", "--mode", "delta", "file1.md", "file2.md"]);
    assert.equal(result.mode, "delta");
    assert.deepEqual(result.files, ["file1.md", "file2.md"]);
  });

  it("handles --mode at the end", () => {
    const result = parseArgs(["node", "plan-review.mjs", "file1.md", "--mode", "full"]);
    assert.equal(result.mode, "full");
    assert.deepEqual(result.files, ["file1.md"]);
  });

  it("returns null mode when --mode is absent", () => {
    const result = parseArgs(["node", "plan-review.mjs", "file1.md", "file2.md"]);
    assert.equal(result.mode, null);
    assert.deepEqual(result.files, ["file1.md", "file2.md"]);
  });

  it("handles single file with no mode", () => {
    const result = parseArgs(["node", "plan-review.mjs", "file1.md"]);
    assert.equal(result.mode, null);
    assert.deepEqual(result.files, ["file1.md"]);
  });

  it("throws on invalid mode value", () => {
    assert.throws(
      () => parseArgs(["node", "plan-review.mjs", "--mode", "invalid", "file1.md"]),
      /Invalid mode/
    );
  });

  it("throws when --mode has no value", () => {
    assert.throws(
      () => parseArgs(["node", "plan-review.mjs", "file1.md", "--mode"]),
      /--mode requires a value/
    );
  });

  it("throws when more than 2 file arguments are passed", () => {
    assert.throws(
      () => parseArgs(["node", "plan-review.mjs", "f1.md", "f2.md", "f3.md"]),
      /Too many file arguments/
    );
  });
});

// Create temp fixture files for buildPrompt tests (it reads files with readFileSync)
const fixtureDir = mkdtempSync(join(tmpdir(), "plan-review-test-"));
const fixtureFile = join(fixtureDir, "test.md");
writeFileSync(fixtureFile, "# Test Document\nSome content here.");

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

import { buildPrompt } from "../scripts/plan-review.mjs";

describe("buildPrompt", () => {
  it("builds full mode prompt with structured JSON contract", () => {
    const prompt = buildPrompt(fixtureFile, null, "full", null);
    assert.ok(prompt.includes("<task>"));
    assert.ok(prompt.includes("```json"));
    assert.ok(prompt.includes("APPROVED"));
    assert.ok(prompt.includes("# Test Document"));
  });

  it("builds delta mode prompt with previous issues", () => {
    const issuesSummary = "[ISS-1] (critical) Task 3: placeholder step";
    const prompt = buildPrompt(fixtureFile, null, "delta", issuesSummary);
    assert.ok(prompt.includes("DELTA REVIEW"));
    assert.ok(prompt.includes("<previous_review_issues>"));
    assert.ok(prompt.includes("[ISS-1] (critical) Task 3: placeholder step"));
    assert.ok(prompt.includes("new_issues"));
  });

  it("builds focused mode prompt without new_issues", () => {
    const issuesSummary = "[ISS-1] (critical) Task 3: placeholder step";
    const prompt = buildPrompt(fixtureFile, null, "focused", issuesSummary);
    assert.ok(prompt.includes("FOCUSED REVIEW"));
    assert.ok(!prompt.includes("new_issues"));
    assert.ok(!prompt.includes("Scan for NEW issues"));
  });
});

// Mode resolution logic extracted for testing (exported from plan-review.mjs)
import { resolveMode } from "../scripts/plan-review.mjs";

describe("resolveMode", () => {
  it("returns full when no previous review exists", () => {
    assert.equal(resolveMode("delta", null), "full");
    assert.equal(resolveMode("focused", null), "full");
  });

  it("returns full when previous review has no issues (APPROVED)", () => {
    const prev = { parseSuccess: true, issues: [] };
    assert.equal(resolveMode("delta", prev), "full");
    assert.equal(resolveMode("focused", prev), "full");
  });

  it("returns full when previous review has parseSuccess: false", () => {
    const prev = { parseSuccess: false, issues: [] };
    assert.equal(resolveMode("delta", prev), "full");
  });

  it("returns requested mode when previous review has issues", () => {
    const prev = {
      parseSuccess: true,
      issues: [{ id: "ISS-1", severity: "critical", section: "S1", description: "d" }],
    };
    assert.equal(resolveMode("delta", prev), "delta");
    assert.equal(resolveMode("focused", prev), "focused");
  });

  it("returns full unchanged when requested mode is already full", () => {
    const prev = {
      parseSuccess: true,
      issues: [{ id: "ISS-1", severity: "critical", section: "S1", description: "d" }],
    };
    assert.equal(resolveMode("full", prev), "full");
  });
});

describe("markReviewCompleted (state machine marker)", () => {
  const testPath = "docs/superpowers/specs/2026-04-11-marker-test.md";
  const markerPath = reviewMarkerPath(testPath);

  function cleanup() {
    if (existsSync(markerPath)) unlinkSync(markerPath);
  }

  it("creates a REVIEWED marker with round=1 on first invocation", () => {
    cleanup();
    const result = markReviewCompleted(testPath);
    assert.equal(result.state, "REVIEWED");
    assert.equal(result.round, 1);
    assert.equal(result.soft_gate_round, 5);
    assert.equal(result.hard_gate_round, 10);
    const onDisk = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(onDisk.state, "REVIEWED");
    assert.equal(onDisk.round, 1);
    cleanup();
  });

  it("increments round on subsequent invocations and preserves gate config", () => {
    cleanup();
    writeFileSync(
      markerPath,
      JSON.stringify({
        state: "PENDING_REVIEW",
        round: 4,
        soft_gate_round: 5,
        hard_gate_round: 10,
      })
    );
    const result = markReviewCompleted(testPath);
    assert.equal(result.state, "REVIEWED");
    assert.equal(result.round, 5);
    assert.equal(result.soft_gate_round, 5);
    assert.equal(result.hard_gate_round, 10);
    cleanup();
  });

  it("recovers from a corrupted marker by starting fresh", () => {
    cleanup();
    writeFileSync(markerPath, "{ not valid json");
    const result = markReviewCompleted(testPath);
    assert.equal(result.state, "REVIEWED");
    assert.equal(result.round, 1);
    cleanup();
  });

  it("produces a marker path under /tmp with sha256(file_path) suffix", () => {
    // Stable deterministic hash check to match the hook's python computation.
    const expectedPrefix = "/tmp/codex-plan-review-";
    assert.ok(markerPath.startsWith(expectedPrefix));
    assert.equal(markerPath.length, expectedPrefix.length + 64 + ".json".length);
  });
});

describe("parseArgs --cwd", () => {
  it("extracts --cwd and returns it", () => {
    const result = parseArgs(["node", "plan-review.mjs", "--cwd", "/proj2", "file.md"]);
    assert.equal(result.cwd, "/proj2");
    assert.deepEqual(result.files, ["file.md"]);
    assert.equal(result.mode, null);
  });

  it("extracts -C alias", () => {
    const result = parseArgs(["node", "plan-review.mjs", "-C", "/proj2", "file.md"]);
    assert.equal(result.cwd, "/proj2");
    assert.deepEqual(result.files, ["file.md"]);
  });

  it("handles --cwd with --mode in any order", () => {
    const r1 = parseArgs(["node", "plan-review.mjs", "--cwd", "/p", "--mode", "full", "f.md"]);
    assert.equal(r1.cwd, "/p");
    assert.equal(r1.mode, "full");
    assert.deepEqual(r1.files, ["f.md"]);

    const r2 = parseArgs(["node", "plan-review.mjs", "--mode", "delta", "--cwd", "/p", "f.md"]);
    assert.equal(r2.cwd, "/p");
    assert.equal(r2.mode, "delta");
    assert.deepEqual(r2.files, ["f.md"]);
  });

  it("throws when --cwd has no value", () => {
    assert.throws(
      () => parseArgs(["node", "plan-review.mjs", "file.md", "--cwd"]),
      /--cwd requires a value/
    );
  });

  it("returns null cwd when --cwd is absent", () => {
    const result = parseArgs(["node", "plan-review.mjs", "file.md"]);
    assert.equal(result.cwd, null);
  });
});
