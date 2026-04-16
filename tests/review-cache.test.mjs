// tests/review-cache.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, saveReview, ensureCacheDir, findPreviousReview, extractIssuesSummary, filePathHash } from "../scripts/review-cache.mjs";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate cache directory per test run
const testCacheDir = mkdtempSync(join(tmpdir(), "codex-plan-review-test-"));
process.env.CODEX_PLAN_REVIEW_CACHE_DIR = testCacheDir;

after(() => {
  rmSync(testCacheDir, { recursive: true, force: true });
});

describe("normalizePath", () => {
  it("resolves a relative path to absolute", () => {
    const result = normalizePath("docs/plans/my-plan.md");
    assert.ok(result.startsWith("/"), "should be absolute");
    assert.ok(result.endsWith("docs/plans/my-plan.md"));
  });

  it("sorts and joins multiple paths", () => {
    const result = normalizePath("z-file.md", "a-file.md");
    const lines = result.split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].endsWith("a-file.md"), "a-file should be first");
    assert.ok(lines[1].endsWith("z-file.md"), "z-file should be second");
  });

  it("removes trailing slashes", () => {
    const result = normalizePath("docs/plans/");
    assert.ok(!result.endsWith("/"));
  });

  it("produces same key regardless of argument order", () => {
    const a = normalizePath("file1.md", "file2.md");
    const b = normalizePath("file2.md", "file1.md");
    assert.equal(a, b);
  });
});

describe("saveReview (full mode)", () => {

  it("parses valid fenced JSON and saves with parseSuccess: true", () => {
    const rawOutput = 'Some text\n```json\n{"verdict":"ISSUES_FOUND","issues":[{"severity":"critical","section":"Task 3","description":"placeholder step"}]}\n```\nSummary here';
    const result = saveReview("/tmp/test-plan.md", rawOutput, "full");
    assert.equal(result.parseSuccess, true);
    assert.equal(result.verdict, "ISSUES_FOUND");
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, "ISS-1");
    assert.equal(result.issues[0].severity, "critical");
    assert.equal(result.issues[0].section, "Task 3");
    assert.equal(result.issues[0].description, "placeholder step");
    assert.equal(result.reviewMode, "full");
  });

  it("returns parseSuccess: false for invalid JSON", () => {
    const rawOutput = "No JSON here, just text";
    const result = saveReview("/tmp/test-plan.md", rawOutput, "full");
    assert.equal(result.parseSuccess, false);
    assert.equal(result.verdict, "UNKNOWN");
    assert.deepEqual(result.issues, []);
    assert.equal(result.rawOutput, rawOutput);
  });

  it("returns parseSuccess: false when verdict is missing", () => {
    const rawOutput = '```json\n{"issues":[]}\n```';
    const result = saveReview("/tmp/test-plan.md", rawOutput, "full");
    assert.equal(result.parseSuccess, false);
  });

  it("corrects verdict to ISSUES_FOUND when issues exist but verdict is APPROVED", () => {
    const rawOutput = '```json\n{"verdict":"APPROVED","issues":[{"severity":"important","section":"S1","description":"d"}]}\n```';
    const result = saveReview("/tmp/test-plan.md", rawOutput, "full");
    assert.equal(result.verdict, "ISSUES_FOUND");
  });

  it("assigns sequential ISS- IDs to issues", () => {
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","issues":[{"severity":"critical","section":"S1","description":"d1"},{"severity":"important","section":"S2","description":"d2"}]}\n```';
    const result = saveReview("/tmp/test-plan.md", rawOutput, "full");
    assert.equal(result.issues[0].id, "ISS-1");
    assert.equal(result.issues[1].id, "ISS-2");
  });
});

describe("findPreviousReview", () => {
  it("returns the most recent review for a filePath", () => {
    // Save two reviews for the same file
    saveReview("/tmp/test-find.md", '```json\n{"verdict":"ISSUES_FOUND","issues":[{"severity":"critical","section":"S1","description":"first"}]}\n```', "full");
    saveReview("/tmp/test-find.md", '```json\n{"verdict":"ISSUES_FOUND","issues":[{"severity":"critical","section":"S1","description":"second"}]}\n```', "full");

    const prev = findPreviousReview("/tmp/test-find.md");
    assert.ok(prev);
    assert.equal(prev.issues[0].description, "second");
  });

  it("returns null when no review exists", () => {
    const prev = findPreviousReview("/tmp/nonexistent-file-xyz.md");
    assert.equal(prev, null);
  });

  it("deterministically returns most recent collision-suffixed file", () => {
    const dir = ensureCacheDir();
    const testPath = "/tmp/test-collision-fixed.md";
    const normalized = normalizePath(testPath);
    const hash = filePathHash(normalized);
    const ts = "20260410T120000000Z";

    const makeReview = (description) => JSON.stringify({
      filePath: normalized,
      fileHash: "test",
      timestamp: ts,
      reviewMode: "full",
      parseSuccess: true,
      verdict: "ISSUES_FOUND",
      issues: [{ id: "ISS-1", severity: "critical", section: "S1", description }],
      previousIssueStatuses: [],
      rawOutput: "",
    });

    writeFileSync(join(dir, `${ts}-${hash}.json`), makeReview("first"));
    writeFileSync(join(dir, `${ts}-${hash}-1.json`), makeReview("second"));
    writeFileSync(join(dir, `${ts}-${hash}-2.json`), makeReview("third"));

    const prev = findPreviousReview(testPath);
    assert.ok(prev);
    assert.equal(prev.issues[0].description, "third");
  });
});

describe("extractIssuesSummary", () => {
  it("returns formatted text for review with issues", () => {
    const review = {
      parseSuccess: true,
      issues: [
        { id: "ISS-1", severity: "critical", section: "Task 3", description: "placeholder step" },
        { id: "ISS-2", severity: "important", section: "Spec 2.1", description: "ambiguous requirement" },
      ],
    };
    const summary = extractIssuesSummary(review);
    assert.equal(summary, "[ISS-1] (critical) Task 3: placeholder step\n[ISS-2] (important) Spec 2.1: ambiguous requirement");
  });

  it("returns null for review with no issues (APPROVED)", () => {
    const review = { parseSuccess: true, issues: [] };
    assert.equal(extractIssuesSummary(review), null);
  });

  it("returns null for review with parseSuccess: false", () => {
    const review = { parseSuccess: false, issues: [] };
    assert.equal(extractIssuesSummary(review), null);
  });

  it("returns null even if issues exist when parseSuccess is false", () => {
    // Defensive: corrupted cache file with stale issues
    const review = {
      parseSuccess: false,
      issues: [{ id: "ISS-1", severity: "critical", section: "S1", description: "stale" }],
    };
    assert.equal(extractIssuesSummary(review), null);
  });

  it("truncates long descriptions to 200 chars", () => {
    const longDesc = "x".repeat(300);
    const review = {
      parseSuccess: true,
      issues: [{ id: "ISS-1", severity: "critical", section: "S1", description: longDesc }],
    };
    const summary = extractIssuesSummary(review);
    assert.ok(summary.length < 250);
    assert.ok(summary.includes("x".repeat(200)));
  });

  it("replaces newlines in descriptions with spaces", () => {
    const review = {
      parseSuccess: true,
      issues: [{ id: "ISS-1", severity: "critical", section: "S1", description: "line1\nline2\nline3" }],
    };
    const summary = extractIssuesSummary(review);
    assert.ok(!summary.includes("\n["), "no newlines mid-issue");
    assert.ok(summary.includes("line1 line2 line3"));
  });
});

describe("saveReview (delta carry-forward)", () => {
  it("carries forward unresolved issues and adds new ones", () => {
    const previousReview = {
      issues: [
        { id: "ISS-1", severity: "critical", section: "Task 3", description: "placeholder step" },
        { id: "ISS-2", severity: "important", section: "Spec 2.1", description: "ambiguous requirement" },
      ],
    };
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"id":"ISS-1","severity":"critical","section":"Task 3","status":"RESOLVED"},{"id":"ISS-2","severity":"important","section":"Spec 2.1","status":"UNRESOLVED","detail":"still unclear"}],"new_issues":[{"severity":"important","section":"Task 5","description":"new problem"}]}\n```';

    const result = saveReview("/tmp/test-delta.md", rawOutput, "delta", previousReview);
    assert.equal(result.parseSuccess, true);
    assert.equal(result.issues.length, 2);
    assert.equal(result.issues[0].id, "ISS-2");
    assert.equal(result.issues[0].description, "still unclear");
    assert.equal(result.issues[1].id, "ISS-3");
    assert.equal(result.issues[1].section, "Task 5");
  });

  it("keeps unmatched previous issues as UNRESOLVED", () => {
    const previousReview = {
      issues: [
        { id: "ISS-1", severity: "critical", section: "S1", description: "orig" },
        { id: "ISS-2", severity: "important", section: "S2", description: "orig2" },
      ],
    };
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"id":"ISS-1","severity":"critical","section":"S1","status":"RESOLVED"}],"new_issues":[]}\n```';

    const result = saveReview("/tmp/test-delta2.md", rawOutput, "delta", previousReview);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, "ISS-2");
    assert.equal(result.issues[0].description, "orig2");
  });

  it("assigns new IDs starting from max(existing) + 1", () => {
    const previousReview = {
      issues: [
        { id: "ISS-3", severity: "critical", section: "S1", description: "d" },
      ],
    };
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"id":"ISS-3","severity":"critical","section":"S1","status":"UNRESOLVED"}],"new_issues":[{"severity":"important","section":"S2","description":"new"}]}\n```';

    const result = saveReview("/tmp/test-delta3.md", rawOutput, "delta", previousReview);
    assert.equal(result.issues[0].id, "ISS-3");
    assert.equal(result.issues[1].id, "ISS-4");
  });

  it("falls back to severity+section matching when ID is missing", () => {
    const previousReview = {
      issues: [
        { id: "ISS-1", severity: "critical", section: "Task 3", description: "orig" },
      ],
    };
    const rawOutput = '```json\n{"verdict":"APPROVED","previous_issue_statuses":[{"severity":"critical","section":"Task 3","status":"RESOLVED"}],"new_issues":[]}\n```';

    const result = saveReview("/tmp/test-delta4.md", rawOutput, "delta", previousReview);
    assert.equal(result.issues.length, 0);
    assert.equal(result.verdict, "APPROVED");
  });

  it("matches duplicate severity+section issues 1:1 in order", () => {
    const previousReview = {
      issues: [
        { id: "ISS-1", severity: "critical", section: "Task 3", description: "first instance" },
        { id: "ISS-2", severity: "critical", section: "Task 3", description: "second instance" },
      ],
    };
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"severity":"critical","section":"Task 3","status":"RESOLVED"},{"severity":"critical","section":"Task 3","status":"UNRESOLVED","detail":"still broken"}],"new_issues":[]}\n```';

    const result = saveReview("/tmp/test-delta-dup.md", rawOutput, "delta", previousReview);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, "ISS-2");
    assert.equal(result.issues[0].description, "still broken");
  });
});

describe("saveReview (multi-file key)", () => {
  it("saves and retrieves multi-file review with order-independent key", () => {
    const f1 = join(testCacheDir, "plan.md");
    const f2 = join(testCacheDir, "spec.md");
    writeFileSync(f1, "# plan");
    writeFileSync(f2, "# spec");

    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","issues":[{"severity":"critical","section":"S1","description":"multi-file issue"}]}\n```';
    saveReview(`${f1}\n${f2}`, rawOutput, "full");

    const found = findPreviousReview(`${f2}\n${f1}`);
    assert.ok(found, "should find multi-file review regardless of order");
    assert.equal(found.issues[0].description, "multi-file issue");
    assert.ok(found.fileHash.includes("\n"), "multi-file fileHash should contain newline separator");
  });
});

describe("saveReview (focused carry-forward)", () => {
  it("only processes previous issues, ignores new_issues", () => {
    const previousReview = {
      issues: [
        { id: "ISS-1", severity: "critical", section: "S1", description: "d" },
      ],
    };
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"id":"ISS-1","severity":"critical","section":"S1","status":"UNRESOLVED","detail":"still bad"}]}\n```';

    const result = saveReview("/tmp/test-focused.md", rawOutput, "focused", previousReview);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, "ISS-1");
    assert.equal(result.issues[0].description, "still bad");
  });
});

describe("saveReview (defensive: no previousReview)", () => {
  it("delta mode without previousReview saves only new_issues", () => {
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[],"new_issues":[{"severity":"critical","section":"S1","description":"new"}]}\n```';
    const result = saveReview("/tmp/test-def-delta.md", rawOutput, "delta");
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, "ISS-1");
    assert.equal(result.issues[0].description, "new");
  });

  it("focused mode without previousReview extracts UNRESOLVED from statuses", () => {
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"id":"ISS-1","severity":"critical","section":"S1","status":"UNRESOLVED","detail":"still bad"},{"id":"ISS-2","severity":"important","section":"S2","status":"RESOLVED"}]}\n```';
    const result = saveReview("/tmp/test-def-focused.md", rawOutput, "focused");
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].description, "still bad");
  });
});
