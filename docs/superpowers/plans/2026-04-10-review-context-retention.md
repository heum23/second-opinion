# Review Context Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex 재리뷰 시 이전 리뷰 결과를 캐시하고, delta/focused 모드로 이전 이슈 해결 여부 중심의 리뷰를 수행하도록 한다.

**Architecture:** 리뷰 결과를 `${TMPDIR}/codex-plan-review-cache/`에 JSON으로 캐시하는 `review-cache.mjs` 모듈을 새로 만들고, `plan-review.mjs`가 이를 import하여 모드 분기 + 캐시 연동 + stdout tee 캡처를 수행한다. `config.mjs`에 `reviewMode` 설정을 추가하고, 명령어 문서를 업데이트한다.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert` (built-in test runner), `node:crypto` (SHA-256), `node:fs`, `node:path`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `scripts/review-cache.mjs` | **New** — 리뷰 캐시 저장/조회/이슈 추출/경로 정규화 |
| `tests/review-cache.test.mjs` | **New** — review-cache.mjs 단위 테스트 |
| `scripts/plan-review.mjs` | **Modify** — `--mode` 파싱, 모드별 프롬프트 빌드, stdout tee, 캐시 연동 |
| `tests/plan-review-args.test.mjs` | **New** — plan-review.mjs 프롬프트 빌더/인자 파싱 테스트 |
| `scripts/config.mjs` | **Modify** — `getReviewMode()` / `setReviewMode()` 추가 |
| `commands/parallel-plan-review.md` | **Modify** — `--mode` 플래그 문서화 |
| `commands/plan-reviewer-change.md` | **Modify** — `mode` 서브커맨드 문서화 |
| `README.md` | **Modify** — 새 기능 반영 |
| `.claude-plugin/plugin.json` | **Modify** — 버전 범프 |

---

### Task 1: review-cache.mjs — normalizePath 및 캐시 디렉토리 초기화

**Files:**
- Create: `scripts/review-cache.mjs`
- Create: `tests/review-cache.test.mjs`

- [ ] **Step 1: Write failing test for normalizePath**

```javascript
// tests/review-cache.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePath } from "../scripts/review-cache.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-cache.test.mjs`
Expected: FAIL with "Cannot find module" or similar

- [ ] **Step 3: Write normalizePath and cache dir helper**

```javascript
// scripts/review-cache.mjs
import { mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

// CODEX_PLAN_REVIEW_CACHE_DIR env var allows tests to isolate the cache directory.
// Read env at call time (not import time) so tests can set it before calling.
function getCacheDir() {
  return process.env.CODEX_PLAN_REVIEW_CACHE_DIR || join(tmpdir(), "codex-plan-review-cache");
}

export function ensureCacheDir() {
  const dir = getCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function normalizePath(...paths) {
  const resolved = paths.map((p) => {
    let r = resolve(p);
    if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
    return r;
  });
  resolved.sort();
  return resolved.join("\n");
}

export function filePathHash(normalizedPath) {
  return createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/review-cache.test.mjs`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/review-cache.mjs tests/review-cache.test.mjs
git commit -m "feat: add review-cache module with normalizePath"
```

---

### Task 2: review-cache.mjs — saveReview (full mode)

**Files:**
- Modify: `scripts/review-cache.mjs`
- Modify: `tests/review-cache.test.mjs`

- [ ] **Step 1: Write failing tests for saveReview full mode**

```javascript
// append to tests/review-cache.test.mjs
import { before, after } from "node:test";
import { saveReview, ensureCacheDir } from "../scripts/review-cache.mjs";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate cache directory per test run
const testCacheDir = mkdtempSync(join(tmpdir(), "codex-plan-review-test-"));
process.env.CODEX_PLAN_REVIEW_CACHE_DIR = testCacheDir;

after(() => {
  rmSync(testCacheDir, { recursive: true, force: true });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-cache.test.mjs`
Expected: FAIL — `saveReview` is not exported / not defined

- [ ] **Step 3: Implement saveReview for full mode**

Add to `scripts/review-cache.mjs`:

```javascript
import { writeFileSync, readFileSync, readdirSync } from "node:fs";

function extractFencedJson(rawOutput) {
  const match = rawOutput.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function validateFullMode(parsed) {
  if (typeof parsed.verdict !== "string") return false;
  if (!["APPROVED", "ISSUES_FOUND"].includes(parsed.verdict)) return false;
  if (!Array.isArray(parsed.issues)) return false;
  for (const issue of parsed.issues) {
    if (!issue.severity || !issue.section || !issue.description) return false;
  }
  return true;
}

const VALID_STATUSES = ["RESOLVED", "UNRESOLVED", "PARTIALLY_RESOLVED"];

function validateDeltaMode(parsed) {
  if (typeof parsed.verdict !== "string") return false;
  if (!["APPROVED", "ISSUES_FOUND"].includes(parsed.verdict)) return false;
  if (!Array.isArray(parsed.previous_issue_statuses)) return false;
  if (!Array.isArray(parsed.new_issues)) return false;
  for (const s of parsed.previous_issue_statuses) {
    if (!VALID_STATUSES.includes(s.status)) return false;
  }
  for (const ni of parsed.new_issues) {
    if (!ni.severity || !ni.section || !ni.description) return false;
  }
  return true;
}

function validateFocusedMode(parsed) {
  if (typeof parsed.verdict !== "string") return false;
  if (!["APPROVED", "ISSUES_FOUND"].includes(parsed.verdict)) return false;
  if (!Array.isArray(parsed.previous_issue_statuses)) return false;
  for (const s of parsed.previous_issue_statuses) {
    if (!VALID_STATUSES.includes(s.status)) return false;
  }
  return true;
}

function correctVerdict(parsed, mode) {
  if (parsed.verdict !== "APPROVED") return;
  if (mode === "full") {
    if (parsed.issues && parsed.issues.length > 0) parsed.verdict = "ISSUES_FOUND";
  } else {
    const hasUnresolved = (parsed.previous_issue_statuses || []).some(
      (s) => s.status === "UNRESOLVED" || s.status === "PARTIALLY_RESOLVED"
    );
    const hasNewIssues = (parsed.new_issues || []).length > 0;
    if (hasUnresolved || hasNewIssues) parsed.verdict = "ISSUES_FOUND";
  }
}

function computeFileHash(filePaths) {
  const normalized = normalizePath(...filePaths.split("\n"));
  const paths = normalized.split("\n");
  const hashes = paths.map((p) => {
    try {
      const content = readFileSync(p, "utf8");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return "unreadable";
    }
  });
  return hashes.join("\n");
}

export function saveReview(filePath, rawOutput, mode, previousReview = null) {
  const dir = ensureCacheDir();
  const normalizedPath = normalizePath(...filePath.split("\n"));
  const parsed = extractFencedJson(rawOutput);

  const validators = { full: validateFullMode, delta: validateDeltaMode, focused: validateFocusedMode };
  const isValid = parsed && validators[mode]?.(parsed);

  if (!isValid) {
    const review = {
      filePath: normalizedPath,
      fileHash: computeFileHash(normalizedPath),
      timestamp: new Date().toISOString(),
      reviewMode: mode,
      parseSuccess: false,
      verdict: "UNKNOWN",
      issues: [],
      previousIssueStatuses: [],
      rawOutput,
    };
    writeFileSync(join(dir, uniqueFilename(review.timestamp, normalizedPath, dir)), JSON.stringify(review, null, 2));
    return review;
  }

  correctVerdict(parsed, mode);

  let issues;
  let previousIssueStatuses = [];

  if (mode === "full") {
    issues = parsed.issues.map((iss, i) => ({
      id: `ISS-${i + 1}`,
      severity: iss.severity,
      section: iss.section,
      description: iss.description,
    }));
  } else {
    // delta/focused carry-forward handled in Task 3
    issues = [];
    previousIssueStatuses = parsed.previous_issue_statuses || [];
  }

  const review = {
    filePath: normalizedPath,
    fileHash: computeFileHash(normalizedPath),
    timestamp: new Date().toISOString(),
    reviewMode: mode,
    parseSuccess: true,
    verdict: parsed.verdict,
    issues,
    previousIssueStatuses,
    rawOutput,
  };

  writeFileSync(join(dir, uniqueFilename(review.timestamp, normalizedPath, dir)), JSON.stringify(review, null, 2));
  return review;
}

// Guarantees unique filename even when called twice in the same millisecond
function uniqueFilename(timestamp, normalizedPath, dir) {
  const ts = timestamp.replace(/[:.]/g, "");
  const hash = filePathHash(normalizedPath);
  const base = `${ts}-${hash}`;
  let candidate = `${base}.json`;
  let counter = 1;
  while (existsSync(join(dir, candidate))) {
    candidate = `${base}-${counter}.json`;
    counter++;
  }
  return candidate;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/review-cache.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/review-cache.mjs tests/review-cache.test.mjs
git commit -m "feat: add saveReview for full mode with JSON parsing and validation"
```

---

### Task 3: review-cache.mjs — findPreviousReview and extractIssuesSummary

**Files:**
- Modify: `scripts/review-cache.mjs`
- Modify: `tests/review-cache.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// append to tests/review-cache.test.mjs
import { findPreviousReview, extractIssuesSummary } from "../scripts/review-cache.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-cache.test.mjs`
Expected: FAIL — `findPreviousReview` or `extractIssuesSummary` not working

- [ ] **Step 3: Implement findPreviousReview and extractIssuesSummary**

Add to `scripts/review-cache.mjs`:

```javascript
export function findPreviousReview(filePath) {
  const dir = ensureCacheDir();
  const normalizedPath = normalizePath(...filePath.split("\n"));
  const pathHash = filePathHash(normalizedPath);

  // Match both base pattern (-<hash>.json) and collision-suffixed (-<hash>-<N>.json)
  const basePattern = new RegExp(`-${pathHash}(-\\d+)?\\.json$`);

  let files;
  try {
    files = readdirSync(dir).filter((f) => basePattern.test(f));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  // Files are named with ISO timestamp prefix, so sorting gives chronological order.
  // Collision-suffixed files sort after their base file (same timestamp), which is correct.
  // Iterate from newest to oldest, verify filePath matches (hash is only 8 chars, collisions possible).
  files.sort();
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const review = JSON.parse(readFileSync(join(dir, files[i]), "utf8"));
      if (review.filePath === normalizedPath) return review;
    } catch {
      continue;
    }
  }
  return null;
}

export function extractIssuesSummary(review) {
  // parseSuccess: false → return null regardless of issues array
  // (per spec: parse failures force full fallback)
  if (review.parseSuccess === false) return null;
  if (!review.issues || review.issues.length === 0) return null;

  return review.issues
    .map((iss) => {
      let desc = iss.description.replace(/\n/g, " ");
      if (desc.length > 200) desc = desc.slice(0, 200);
      return `[${iss.id}] (${iss.severity}) ${iss.section}: ${desc}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/review-cache.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/review-cache.mjs tests/review-cache.test.mjs
git commit -m "feat: add findPreviousReview and extractIssuesSummary"
```

---

### Task 4: review-cache.mjs — delta/focused carry-forward logic

**Files:**
- Modify: `scripts/review-cache.mjs`
- Modify: `tests/review-cache.test.mjs`

- [ ] **Step 1: Write failing tests for carry-forward**

```javascript
// append to tests/review-cache.test.mjs
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
    // ISS-1 resolved → excluded, ISS-2 unresolved → kept, new issue → ISS-3
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
    // Codex only returned status for ISS-1, omitted ISS-2
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"id":"ISS-1","severity":"critical","section":"S1","status":"RESOLVED"}],"new_issues":[]}\n```';

    const result = saveReview("/tmp/test-delta2.md", rawOutput, "delta", previousReview);
    // ISS-1 resolved, ISS-2 unmatched → kept as UNRESOLVED with original description
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
    assert.equal(result.issues[0].id, "ISS-3"); // kept
    assert.equal(result.issues[1].id, "ISS-4"); // new: max(3) + 1
  });

  it("falls back to severity+section matching when ID is missing", () => {
    const previousReview = {
      issues: [
        { id: "ISS-1", severity: "critical", section: "Task 3", description: "orig" },
      ],
    };
    // Codex didn't echo the ID
    const rawOutput = '```json\n{"verdict":"APPROVED","previous_issue_statuses":[{"severity":"critical","section":"Task 3","status":"RESOLVED"}],"new_issues":[]}\n```';

    const result = saveReview("/tmp/test-delta4.md", rawOutput, "delta", previousReview);
    assert.equal(result.issues.length, 0); // ISS-1 matched by severity+section → resolved
    assert.equal(result.verdict, "APPROVED");
  });

  it("matches duplicate severity+section issues 1:1 in order", () => {
    const previousReview = {
      issues: [
        { id: "ISS-1", severity: "critical", section: "Task 3", description: "first instance" },
        { id: "ISS-2", severity: "critical", section: "Task 3", description: "second instance" },
      ],
    };
    // Codex returns two statuses without IDs: first RESOLVED, second UNRESOLVED
    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","previous_issue_statuses":[{"severity":"critical","section":"Task 3","status":"RESOLVED"},{"severity":"critical","section":"Task 3","status":"UNRESOLVED","detail":"still broken"}],"new_issues":[]}\n```';

    const result = saveReview("/tmp/test-delta-dup.md", rawOutput, "delta", previousReview);
    // 1:1 order matching: ISS-1 → resolved (excluded), ISS-2 → unresolved (kept)
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, "ISS-2");
    assert.equal(result.issues[0].description, "still broken");
  });
});

describe("saveReview (multi-file key)", () => {
  it("saves and retrieves multi-file review with order-independent key", () => {
    // Create two real files so computeFileHash can read them
    // (testCacheDir is defined at top of file; writeFileSync is imported there)
    const f1 = join(testCacheDir, "plan.md");
    const f2 = join(testCacheDir, "spec.md");
    writeFileSync(f1, "# plan");
    writeFileSync(f2, "# spec");

    const rawOutput = '```json\n{"verdict":"ISSUES_FOUND","issues":[{"severity":"critical","section":"S1","description":"multi-file issue"}]}\n```';
    // Save with order (plan, spec)
    saveReview(`${f1}\n${f2}`, rawOutput, "full");

    // Retrieve with reversed order (spec, plan) — should find same review
    const found = findPreviousReview(`${f2}\n${f1}`);
    assert.ok(found, "should find multi-file review regardless of order");
    assert.equal(found.issues[0].description, "multi-file issue");
    // fileHash should contain both per-file SHA-256s joined by newline
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
    // Only UNRESOLVED item should be kept
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].description, "still bad");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/review-cache.test.mjs`
Expected: FAIL — delta/focused carry-forward not implemented

- [ ] **Step 3: Implement carry-forward logic in saveReview**

Replace the `// delta/focused carry-forward handled in Task 3` placeholder in `saveReview()`:

```javascript
  } else {
    // delta/focused carry-forward
    previousIssueStatuses = parsed.previous_issue_statuses || [];

    if (previousReview && previousReview.issues) {
      const statusMap = new Map();

      // Build map: try ID match first, then severity+section
      for (const s of previousIssueStatuses) {
        if (s.id) {
          statusMap.set(s.id, s);
        }
      }

      // Track which statuses have been consumed
      const consumedStatuses = new Set();
      const unresolvedFromPrev = [];

      for (const prevIssue of previousReview.issues) {
        // Try ID match
        let matched = statusMap.get(prevIssue.id);
        if (matched) {
          consumedStatuses.add(matched);
        } else {
          // Fallback: severity+section exact match (first unconsumed)
          matched = previousIssueStatuses.find(
            (s) =>
              !consumedStatuses.has(s) &&
              s.severity === prevIssue.severity &&
              s.section === prevIssue.section
          );
          if (matched) consumedStatuses.add(matched);
        }

        if (matched && matched.status === "RESOLVED") {
          // Exclude from issues
          continue;
        }

        // UNRESOLVED, PARTIALLY_RESOLVED, or unmatched → keep
        unresolvedFromPrev.push({
          id: prevIssue.id,
          severity: prevIssue.severity,
          section: prevIssue.section,
          description: matched?.detail || prevIssue.description,
        });
      }

      // Determine next ID from ALL previous issues (including resolved ones) to avoid ID reuse
      const allPrevNums = previousReview.issues.map((i) => parseInt(i.id.replace("ISS-", ""), 10));
      let nextId = allPrevNums.length > 0 ? Math.max(...allPrevNums) + 1 : 1;

      // Add new issues (delta mode only)
      const newIssues = mode === "delta" ? (parsed.new_issues || []) : [];
      for (const ni of newIssues) {
        unresolvedFromPrev.push({
          id: `ISS-${nextId++}`,
          severity: ni.severity,
          section: ni.section,
          description: ni.description,
        });
      }

      issues = unresolvedFromPrev;
    } else {
      // Defensive: no previousReview (shouldn't happen in normal flow)
      if (mode === "delta") {
        issues = (parsed.new_issues || []).map((ni, i) => ({
          id: `ISS-${i + 1}`,
          severity: ni.severity,
          section: ni.section,
          description: ni.description,
        }));
      } else {
        // focused: extract unresolved from statuses
        issues = previousIssueStatuses
          .filter((s) => s.status === "UNRESOLVED" || s.status === "PARTIALLY_RESOLVED")
          .map((s, i) => ({
            id: s.id || `ISS-${i + 1}`,
            severity: s.severity || "unknown",
            section: s.section || "unknown",
            description: s.detail || "unresolved issue",
          }));
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/review-cache.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/review-cache.mjs tests/review-cache.test.mjs
git commit -m "feat: add delta/focused carry-forward logic to saveReview"
```

---

### Task 5: config.mjs — getReviewMode / setReviewMode

**Files:**
- Modify: `scripts/config.mjs`
- Create: `tests/config.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// tests/config.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// Isolate settings by creating a temp HOME directory
import { mkdirSync } from "node:fs";
const testHome = mkdtempSync(join(tmpdir(), "codex-config-test-"));
const testClaudeDir = join(testHome, ".claude");
mkdirSync(testClaudeDir, { recursive: true });
writeFileSync(join(testClaudeDir, "settings.json"), "{}");

const env = { ...process.env, HOME: testHome };

after(() => {
  rmSync(testHome, { recursive: true, force: true });
});

describe("config.mjs mode subcommand", () => {
  it("shows current mode when called with 'mode' and no value", () => {
    const output = execSync("node scripts/config.mjs mode", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("리뷰 모드"));
  });

  it("sets mode to full", () => {
    const output = execSync("node scripts/config.mjs mode full", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("full"));
  });

  it("rejects invalid mode", () => {
    try {
      execSync("node scripts/config.mjs mode invalid", { encoding: "utf8", cwd: process.cwd(), env });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e.stderr.includes("유효하지 않은") || e.status !== 0);
    }
  });

  it("backward compat: bare model name still works", () => {
    const output = execSync("node scripts/config.mjs spark", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("spark"));
  });
});

// Direct import tests for the exported API (used by plan-review.mjs)
// Note: these run against the real HOME since we can't change env after import.
// Use CLI tests above for mutation; these only test read behavior.
describe("getReviewMode export", () => {
  it("returns 'delta' as default when no setting exists", async () => {
    // Import with isolated HOME
    const tempHome = mkdtempSync(join(tmpdir(), "codex-config-import-"));
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    writeFileSync(join(tempHome, ".claude", "settings.json"), "{}");
    // Can't re-import with different HOME, so test via subprocess
    const output = execSync(
      `node -e "import('./scripts/config.mjs').then(m => console.log(m.getReviewMode()))"`,
      { encoding: "utf8", cwd: process.cwd(), env: { ...process.env, HOME: tempHome } }
    );
    assert.equal(output.trim(), "delta");
    rmSync(tempHome, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.mjs`
Expected: FAIL — `mode` subcommand not recognized

- [ ] **Step 3: Implement getReviewMode / setReviewMode and extend CLI**

Replace `scripts/config.mjs` with:

```javascript
#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS_PATH = join(process.env.HOME || "", ".claude", "settings.json");
const PLUGIN_KEY = "codex-plan-review@codex-plan-review";
const VALID_MODES = ["full", "delta", "focused"];

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getOptions(settings) {
  return settings?.pluginConfigs?.[PLUGIN_KEY]?.options || {};
}

function ensureOptions(settings) {
  if (!settings.pluginConfigs) settings.pluginConfigs = {};
  if (!settings.pluginConfigs[PLUGIN_KEY]) settings.pluginConfigs[PLUGIN_KEY] = {};
  if (!settings.pluginConfigs[PLUGIN_KEY].options) settings.pluginConfigs[PLUGIN_KEY].options = {};
  return settings.pluginConfigs[PLUGIN_KEY].options;
}

function save(settings) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

// Exported for use by plan-review.mjs
export function getCurrentModel(settings) {
  return getOptions(settings || readSettings()).model || null;
}

export function getReviewMode(settings) {
  const stored = getOptions(settings || readSettings()).reviewMode;
  // Validate stored value; fall back to "delta" if invalid or missing
  if (stored && VALID_MODES.includes(stored)) return stored;
  return "delta";
}

export function setReviewMode(settings, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode: ${mode} (valid: ${VALID_MODES.join(", ")})`);
  }
  const opts = ensureOptions(settings);
  opts.reviewMode = mode;
  save(settings);
}

// Only run CLI logic when executed directly (not imported as module)
import { resolve } from "node:path";
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (!isMain) {
  // Imported as module — skip CLI execution
} else {
  runCli();
}

function runCli() {
const [subcommand, value] = process.argv.slice(2);
const settings = readSettings();

if (!subcommand) {
  const model = getCurrentModel(settings);
  const mode = getReviewMode(settings);
  console.log(`현재 모델: ${model || "기본값"}`);
  console.log(`현재 리뷰 모드: ${mode}`);
  console.log(`\n사용법:`);
  console.log(`  /plan-reviewer-change model <모델명>   모델 변경`);
  console.log(`  /plan-reviewer-change model default    기본값 복원`);
  console.log(`  /plan-reviewer-change mode <모드>      리뷰 모드 변경 (full, delta, focused)`);
  process.exit(0);
}

if (subcommand === "model") {
  if (!value) {
    console.log(`현재 모델: ${getCurrentModel(settings) || "기본값"}`);
    process.exit(0);
  }
  const opts = ensureOptions(settings);
  if (value === "default") {
    delete opts.model;
    save(settings);
    console.log("✓ 모델이 기본값으로 변경되었습니다.");
  } else {
    opts.model = value;
    save(settings);
    console.log(`✓ 모델이 "${value}"으로 변경되었습니다.`);
  }
} else if (subcommand === "mode") {
  if (!value) {
    console.log(`현재 리뷰 모드: ${getReviewMode(settings)}`);
    process.exit(0);
  }
  if (!VALID_MODES.includes(value)) {
    console.error(`유효하지 않은 모드: ${value} (사용 가능: ${VALID_MODES.join(", ")})`);
    process.exit(1);
  }
  setReviewMode(settings, value);
  console.log(`✓ 리뷰 모드가 "${value}"으로 변경되었습니다.`);
} else {
  // Backward compatibility: treat bare argument as model name
  const opts = ensureOptions(settings);
  if (subcommand === "default") {
    delete opts.model;
    save(settings);
    console.log("✓ 모델이 기본값으로 변경되었습니다.");
  } else {
    opts.model = subcommand;
    save(settings);
    console.log(`✓ 모델이 "${subcommand}"으로 변경되었습니다.`);
  }
} // end runCli
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/config.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/config.mjs tests/config.test.mjs
git commit -m "feat: add reviewMode get/set with mode subcommand to config.mjs"
```

---

### Task 6: plan-review.mjs — --mode flag parsing and mode resolution

**Files:**
- Modify: `scripts/plan-review.mjs`
- Create: `tests/plan-review-args.test.mjs`

- [ ] **Step 1: Write failing tests for argument parsing**

```javascript
// tests/plan-review-args.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/plan-review.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/plan-review-args.test.mjs`
Expected: FAIL — `parseArgs` not exported

- [ ] **Step 3: Implement parseArgs and refactor plan-review.mjs entry point**

Refactor `scripts/plan-review.mjs` — **replace the entire file contents** with the following. This keeps the existing review execution flow fully functional (no broken intermediate state), while adding: `parseArgs` export, `isMain` guard, config.mjs import. The `buildPrompt` signature is extended with `mode`/`issuesSummary` parameters but still returns the same full-mode prompt (delta/focused branches added in Task 7). The existing file validation, codex-companion spawn, and stderr filtering are preserved as-is:

```javascript
#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getReviewMode, getCurrentModel } from "./config.mjs";

const VALID_MODES = ["full", "delta", "focused"];

export function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = null;
  const files = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") {
      if (i + 1 >= args.length) {
        throw new Error("--mode requires a value");
      }
      mode = args[i + 1];
      if (!VALID_MODES.includes(mode)) {
        throw new Error(`Invalid mode: ${mode} (valid: ${VALID_MODES.join(", ")})`);
      }
      i++; // skip value
    } else {
      files.push(args[i]);
    }
  }

  if (files.length > 2) {
    throw new Error(`Too many file arguments (max 2, got ${files.length}): ${files.join(", ")}`);
  }

  return { mode, files };
}

// Full-mode prompt (existing behavior preserved, buildPrompt extended in Task 7)
export function buildPrompt(planOrSpec, spec, mode = "full", issuesSummary = null) {
  const header = `<task>
Review the following documents for implementation readiness.

1. SPEC REVIEW (if spec provided): Check each requirement for clarity, completeness,
   testability, and internal consistency. Flag ambiguous or untestable requirements.

2. PLAN-SPEC CROSS-REFERENCE (if both provided): For each spec requirement,
   find the plan task that implements it. List any requirements with no corresponding task.

3. PLAN REVIEW (if plan provided): Check each task for:
   - Actionability (no placeholders, no vague steps, actual code shown)
   - Correct file paths and API references
   - Type/function name consistency across tasks
   - TDD structure (test before implementation)
   - Missing steps that would block an engineer

4. FEASIBILITY: Flag architectural concerns, risky assumptions, or
   steps that depend on undocumented behavior.
</task>

<structured_output_contract>
Return exactly:
1. Verdict: APPROVED or ISSUES_FOUND
2. Spec issues (with section references)
3. Spec coverage gaps (spec requirements not in plan, if both provided)
4. Plan critical issues (would block implementation)
5. Plan important issues (should fix before starting)
6. Suggestions (nice-to-have)
Put highest-severity items first within each section.
</structured_output_contract>

<grounding_rules>
Ground every finding in the actual document text.
Reference specific spec sections, task numbers, and step numbers.
Do not flag style preferences or hypothetical issues.
</grounding_rules>

<verification_loop>
Before finalizing, re-read each requirement and verify your findings are accurate.
Only flag issues that would cause real implementation problems.
</verification_loop>

--- DOCUMENTS ---
`;

  let body = "";
  if (spec) {
    body += `\n=== PLAN: ${planOrSpec} ===\n`;
    body += readFileSync(planOrSpec, "utf8");
    body += `\n\n=== SPEC: ${spec} ===\n`;
    body += readFileSync(spec, "utf8");
  } else {
    body += `\n=== DOCUMENT: ${planOrSpec} ===\n`;
    body += readFileSync(planOrSpec, "utf8");
  }

  return header + body;
}

// Only run main logic when executed directly (not imported for tests)
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main();
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { mode: cliMode, files } = parsed;
  const [file1, file2] = files;

  if (!file1) {
    console.error("Usage: plan-review.mjs [--mode full|delta|focused] <plan-or-spec> [spec-path]");
    process.exit(1);
  }

  if (!existsSync(file1)) {
    console.error(`File not found: ${file1}`);
    process.exit(1);
  }

  if (file2 && !existsSync(file2)) {
    console.error(`File not found: ${file2}`);
    process.exit(1);
  }

  // Mode resolution will be added in Task 7. For now, build full-mode prompt.
  const prompt = buildPrompt(file1, file2);

  // Find codex-companion.mjs
  let codexScript;
  try {
    codexScript = execSync(
      'find ~/.claude/plugins -name "codex-companion.mjs" -path "*/openai-codex/*" 2>/dev/null | head -1',
      { encoding: "utf8" }
    ).trim();
  } catch {
    codexScript = "";
  }

  if (!codexScript) {
    console.error("codex-companion.mjs not found. Is the codex plugin installed?");
    process.exit(1);
  }

  // Build command args — use getCurrentModel from config.mjs
  const tmpDirSpawn = mkdtempSync(join(tmpdir(), "codex-plan-review-"));
  const promptFile = join(tmpDirSpawn, "prompt.txt");
  writeFileSync(promptFile, prompt);

  const args = [codexScript, "task", "--prompt-file", promptFile];
  const model = getCurrentModel();
  if (model) {
    args.push("--model", model);
  }

  // Spawn codex-companion: inherit stdin/stdout, pipe stderr to filter
  const child = spawn("node", args, {
    stdio: ["inherit", "inherit", "pipe"],
    cwd: process.cwd(),
  });

  child.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("[codex] ")) {
        process.stderr.write(line + "\n");
      } else if (trimmed.startsWith("[codex] Assistant message captured: ")) {
        const msg = trimmed.slice("[codex] Assistant message captured: ".length);
        process.stderr.write(`[codex] ${msg}\n`);
      }
    }
  });

  child.on("exit", (code) => {
    try { unlinkSync(promptFile); } catch {}
    process.exit(code ?? 0);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/plan-review-args.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan-review.mjs tests/plan-review-args.test.mjs
git commit -m "refactor: add parseArgs and isMain guard to plan-review.mjs (behavior unchanged)"
```

---

### Task 7: plan-review.mjs — delta/focused prompt builders and stdout tee

**Files:**
- Modify: `scripts/plan-review.mjs`
- Modify: `tests/plan-review-args.test.mjs`

- [ ] **Step 1: Write failing tests for prompt builders**

```javascript
// append to tests/plan-review-args.test.mjs
import { buildPrompt } from "../scripts/plan-review.mjs";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after } from "node:test";

// Create temp fixture files for buildPrompt tests (it reads files with readFileSync)
const fixtureDir = mkdtempSync(join(tmpdir(), "plan-review-test-"));
const fixtureFile = join(fixtureDir, "test.md");
writeFileSync(fixtureFile, "# Test Document\nSome content here.");

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/plan-review-args.test.mjs`
Expected: FAIL — `buildPrompt` doesn't accept mode/issuesSummary params

- [ ] **Step 3: Implement buildPrompt with mode branching and stdout tee**

Replace the `buildPrompt` function in `scripts/plan-review.mjs`:

```javascript
export function buildPrompt(planOrSpec, spec, mode = "full", issuesSummary = null) {
  let body = "";
  if (spec) {
    body += `\n=== PLAN: ${planOrSpec} ===\n`;
    body += readFileSync(planOrSpec, "utf8");
    body += `\n\n=== SPEC: ${spec} ===\n`;
    body += readFileSync(spec, "utf8");
  } else {
    body += `\n=== DOCUMENT: ${planOrSpec} ===\n`;
    body += readFileSync(planOrSpec, "utf8");
  }

  if (mode === "full") {
    return buildFullPrompt(body);
  } else if (mode === "delta") {
    return buildDeltaPrompt(body, issuesSummary);
  } else if (mode === "focused") {
    return buildFocusedPrompt(body, issuesSummary);
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}

function buildFullPrompt(body) {
  return `<task>
Review the following documents for implementation readiness.

1. SPEC REVIEW (if spec provided): Check each requirement for clarity, completeness,
   testability, and internal consistency. Flag ambiguous or untestable requirements.

2. PLAN-SPEC CROSS-REFERENCE (if both provided): For each spec requirement,
   find the plan task that implements it. List any requirements with no corresponding task.

3. PLAN REVIEW (if plan provided): Check each task for:
   - Actionability (no placeholders, no vague steps, actual code shown)
   - Correct file paths and API references
   - Type/function name consistency across tasks
   - TDD structure (test before implementation)
   - Missing steps that would block an engineer

4. FEASIBILITY: Flag architectural concerns, risky assumptions, or
   steps that depend on undocumented behavior.
</task>

<structured_output_contract>
Return your findings as a fenced JSON block (\`\`\`json ... \`\`\`):

{
  "verdict": "APPROVED or ISSUES_FOUND",
  "issues": [
    {
      "severity": "critical | important | suggestion",
      "section": "<section reference>",
      "description": "<issue description>"
    }
  ]
}

After the JSON block, add numbered prose sections:
1. Spec issues (with section references)
2. Spec coverage gaps (spec requirements not in plan, if both provided)
3. Plan critical issues (would block implementation)
4. Plan important issues (should fix before starting)
5. Suggestions (nice-to-have)
Put highest-severity items first within each section.
</structured_output_contract>

<grounding_rules>
Ground every finding in the actual document text.
Reference specific spec sections, task numbers, and step numbers.
Do not flag style preferences or hypothetical issues.
</grounding_rules>

<verification_loop>
Before finalizing, re-read each requirement and verify your findings are accurate.
Only flag issues that would cause real implementation problems.
</verification_loop>

--- DOCUMENTS ---
${body}`;
}

function buildDeltaPrompt(body, issuesSummary) {
  return `<task>
You are performing a DELTA REVIEW. A previous review found issues
in this document. The author has made revisions.

Your job:
1. For each previous issue, determine: RESOLVED / UNRESOLVED / PARTIALLY_RESOLVED
2. If unresolved, explain what still needs fixing
3. Scan for NEW issues introduced by the revisions
</task>

<previous_review_issues>
${issuesSummary}
</previous_review_issues>

<structured_output_contract>
Return your findings as a fenced JSON block (\`\`\`json ... \`\`\`):

{
  "verdict": "APPROVED or ISSUES_FOUND",
  "previous_issue_statuses": [
    {
      "id": "<echo the ID from previous_review_issues>",
      "severity": "<echo the severity>",
      "section": "<echo the section>",
      "status": "RESOLVED | UNRESOLVED | PARTIALLY_RESOLVED",
      "detail": "<what still needs fixing>"
    }
  ],
  "new_issues": [
    {
      "severity": "critical | important | suggestion",
      "section": "<section reference>",
      "description": "<issue description>"
    }
  ]
}

Echo the id, severity, and section fields exactly as given in previous_review_issues.
Omit "detail" for RESOLVED issues.
After the JSON block, add a plain-text Summary section.
</structured_output_contract>

<grounding_rules>
Ground every finding in the actual document text.
Reference specific spec sections, task numbers, and step numbers.
Do not flag style preferences or hypothetical issues.
</grounding_rules>

--- DOCUMENTS ---
${body}`;
}

function buildFocusedPrompt(body, issuesSummary) {
  return `<task>
You are performing a FOCUSED REVIEW. A previous review found issues
in this document. The author has made revisions.

Your job:
1. For each previous issue, determine: RESOLVED / UNRESOLVED / PARTIALLY_RESOLVED
2. If unresolved, explain what still needs fixing
Do NOT scan for new issues. Only verify the listed previous issues.
</task>

<previous_review_issues>
${issuesSummary}
</previous_review_issues>

<structured_output_contract>
Return your findings as a fenced JSON block (\`\`\`json ... \`\`\`):

{
  "verdict": "APPROVED or ISSUES_FOUND",
  "previous_issue_statuses": [
    {
      "id": "<echo the ID from previous_review_issues>",
      "severity": "<echo the severity>",
      "section": "<echo the section>",
      "status": "RESOLVED | UNRESOLVED | PARTIALLY_RESOLVED",
      "detail": "<what still needs fixing>"
    }
  ]
}

Echo the id, severity, and section fields exactly as given in previous_review_issues.
Omit "detail" for RESOLVED issues.
After the JSON block, add a plain-text Summary section.
</structured_output_contract>

<grounding_rules>
Ground every finding in the actual document text.
Reference specific spec sections, task numbers, and step numbers.
Do not flag style preferences or hypothetical issues.
</grounding_rules>

--- DOCUMENTS ---
${body}`;
}
```

Also add the review-cache import at the top of the file (below the existing imports):

```javascript
import { normalizePath, findPreviousReview, extractIssuesSummary, saveReview } from "./review-cache.mjs";
```

Add an exported `resolveMode` function (right after `parseArgs`):

```javascript
// Returns the mode to actually use, falling back to "full" when delta/focused has no valid baseline.
export function resolveMode(requestedMode, previousReview) {
  if (requestedMode === "full") return "full";
  if (!previousReview) return "full";
  if (previousReview.parseSuccess === false) return "full";
  if (!previousReview.issues || previousReview.issues.length === 0) return "full";
  return requestedMode;
}
```

Now **replace** the `main()` function to add mode resolution, stdout tee, and save review:

```javascript
function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { mode: cliMode, files } = parsed;
  const [file1, file2] = files;

  if (!file1) {
    console.error("Usage: plan-review.mjs [--mode full|delta|focused] <plan-or-spec> [spec-path]");
    process.exit(1);
  }

  if (!existsSync(file1)) {
    console.error(`File not found: ${file1}`);
    process.exit(1);
  }

  if (file2 && !existsSync(file2)) {
    console.error(`File not found: ${file2}`);
    process.exit(1);
  }

  // Resolve file path key for cache
  const filePaths = file2 ? [file1, file2] : [file1];
  const normalizedPath = normalizePath(...filePaths);

  // Check previous review
  const previousReview = findPreviousReview(normalizedPath);

  // Resolve mode: CLI flag > settings > "delta" default, then fallback to full if no baseline
  const settingsMode = getReviewMode();
  const requestedMode = cliMode || settingsMode;
  const resolvedMode = resolveMode(requestedMode, previousReview);

  // Extract issues summary for delta/focused (will be null for full mode, which is fine)
  const issuesSummary = resolvedMode !== "full" ? extractIssuesSummary(previousReview) : null;

  // Build prompt
  const prompt = buildPrompt(file1, file2, resolvedMode, issuesSummary);
  const tmpDir = mkdtempSync(join(tmpdir(), "codex-plan-review-"));
  const promptFile = join(tmpDir, "prompt.txt");
  writeFileSync(promptFile, prompt);

  // Find codex-companion.mjs
  let codexScript;
  try {
    codexScript = execSync(
      'find ~/.claude/plugins -name "codex-companion.mjs" -path "*/openai-codex/*" 2>/dev/null | head -1',
      { encoding: "utf8" }
    ).trim();
  } catch {
    codexScript = "";
  }

  if (!codexScript) {
    console.error("codex-companion.mjs not found. Is the codex plugin installed?");
    process.exit(1);
  }

  // Build command args
  const args = [codexScript, "task", "--prompt-file", promptFile];
  const model = getCurrentModel();
  if (model) {
    args.push("--model", model);
  }

  // Spawn codex-companion: pipe stdout for tee capture, pipe stderr for filtering
  const stdoutChunks = [];
  const child = spawn("node", args, {
    stdio: ["inherit", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  // Tee stdout: display live and capture for saveReview
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdoutChunks.push(chunk);
  });

  // Filter [codex] stderr: show assistant thinking, suppress command execution noise
  child.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("[codex] ")) {
        process.stderr.write(line + "\n");
      } else if (trimmed.startsWith("[codex] Assistant message captured: ")) {
        const msg = trimmed.slice("[codex] Assistant message captured: ".length);
        process.stderr.write(`[codex] ${msg}\n`);
      }
    }
  });

  // Track exit code from 'exit' event, but process output on 'close'
  // ('close' fires after all streams are flushed, 'exit' may fire while streams still have data)
  let exitCode = 0;
  child.on("exit", (code) => {
    exitCode = code ?? 0;
  });

  child.on("close", () => {
    try { unlinkSync(promptFile); } catch {}

    // Save review to cache — always save (even empty output) so failed runs are preserved
    // as parseSuccess: false, allowing next invocation to fall back to full mode.
    const rawOutput = Buffer.concat(stdoutChunks).toString("utf8");
    saveReview(normalizedPath, rawOutput, resolvedMode, previousReview);

    process.exit(exitCode);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/plan-review-args.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan-review.mjs tests/plan-review-args.test.mjs
git commit -m "feat: add delta/focused prompt builders, stdout tee, and cache integration"
```

---

### Task 8: commands — update parallel-plan-review.md and plan-reviewer-change.md

**Files:**
- Modify: `commands/parallel-plan-review.md`
- Modify: `commands/plan-reviewer-change.md`

- [ ] **Step 1: Update parallel-plan-review.md**

Replace `commands/parallel-plan-review.md` with:

```markdown
---
name: parallel-plan-review
description: Plan/Spec 파일을 수동으로 Codex 리뷰 요청 (파일 경로 전달, --mode 지원)
argument-hint: '[--mode full|delta|focused] <plan-or-spec-path> [spec-path]'
allowed-tools: Bash, Read, Edit, Glob
---

## Manual Codex Plan/Spec Review

Run Codex review on the specified plan or spec file.

### Usage

```
/parallel-plan-review docs/superpowers/plans/my-plan.md
/parallel-plan-review docs/superpowers/plans/my-plan.md docs/superpowers/specs/my-spec.md
/parallel-plan-review docs/superpowers/specs/my-spec.md --mode full
/parallel-plan-review --mode focused docs/superpowers/plans/my-plan.md
```

### Review Modes

- **delta** (default): 이전 리뷰 이슈 해결 여부 확인 + 새 이슈 탐색. 이전 리뷰 없으면 full fallback.
- **full**: 전체 리뷰 (이전 리뷰 무시)
- **focused**: 이전 리뷰 이슈 재검증만, 새 이슈 탐색 없음. 이전 리뷰 없으면 full fallback.

### Instructions

1. **Resolve arguments**: The user provided: `$ARGUMENTS`
   - Extract `--mode <value>` if present (can appear anywhere in arguments). Valid values: `full`, `delta`, `focused`.
   - Remaining arguments are file paths.
   - If TWO paths given: first is plan, second is spec
   - If ONE path given and it contains `/plans/`: it's a plan — check for corresponding spec by replacing `/plans/` with `/specs/`
   - If ONE path given and it contains `/specs/`: it's a spec only
   - If no file arguments given: use Glob to find the most recently modified `docs/superpowers/{plans,specs}/*.md` file and confirm with user

2. **Run the Codex review** as a Bash call:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" [--mode <mode>] "<file1>" ["<file2>"]
   ```
   Set Bash timeout to **600000** (10 minutes).

3. **Process results**: Read the Codex review output. If issues are found, fix them with Edit, then re-run the review to confirm.
```

- [ ] **Step 2: Update plan-reviewer-change.md**

Replace `commands/plan-reviewer-change.md` with:

```markdown
---
name: plan-reviewer-change
description: Codex plan review 모델 또는 리뷰 모드 변경 (model/mode 서브커맨드)
argument-hint: '<model|mode> [value]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" $ARGUMENTS`
```

- [ ] **Step 3: Commit**

```bash
git add commands/parallel-plan-review.md commands/plan-reviewer-change.md
git commit -m "docs: update command docs with --mode flag and mode subcommand"
```

---

### Task 9: README.md and plugin.json — version bump and docs update

**Files:**
- Modify: `README.md`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Update plugin.json version**

Change `"version": "5.9.1"` to `"version": "6.0.0"` in `.claude-plugin/plugin.json` (major version bump — new feature with behavioral change in prompt format).

- [ ] **Step 2: Update README.md**

Add the following sections to `README.md`:

After the "## 동작 방식" section's flow diagram, add a new section:

```markdown
## 리뷰 모드

재리뷰 시 이전 리뷰 컨텍스트를 자동으로 활용합니다.

| 모드 | 설명 | 이전 리뷰 필요 |
|------|------|:---:|
| `delta` (기본) | 이전 이슈 해결 여부 + 새 이슈 탐색 | Yes (없으면 full) |
| `full` | 전체 리뷰 (기존 동작) | No |
| `focused` | 이전 이슈 재검증만 | Yes (없으면 full) |

리뷰 결과는 `${TMPDIR}/codex-plan-review-cache/`에 캐시됩니다.
```

Update the `/parallel-plan-review` command section:

```markdown
### `/parallel-plan-review`

계획/스펙 파일에 대해 수동으로 Codex 리뷰를 요청합니다.

```bash
/parallel-plan-review docs/superpowers/plans/my-plan.md                    # 계획 리뷰 (대응 스펙 자동 탐색)
/parallel-plan-review docs/superpowers/plans/my-plan.md my-spec.md         # 계획 + 스펙 교차 리뷰
/parallel-plan-review docs/superpowers/specs/my-spec.md                    # 스펙 리뷰
/parallel-plan-review                                                       # 최근 수정된 파일 자동 탐색
/parallel-plan-review docs/superpowers/specs/my-spec.md --mode full        # 모드 오버라이드
```
```

Update the `/plan-reviewer-change` command section:

```markdown
### `/plan-reviewer-change`

모델 또는 리뷰 모드를 변경합니다.

```bash
/plan-reviewer-change                  # 현재 설정 확인
/plan-reviewer-change model spark      # 모델 변경
/plan-reviewer-change model default    # 모델 기본값 복원
/plan-reviewer-change mode delta       # 리뷰 모드 변경
/plan-reviewer-change mode full
/plan-reviewer-change mode focused
```
```

Update the project structure to include new files:

```
├── scripts/
│   ├── plan-review.mjs         # 프롬프트 생성 → codex-companion 위임
│   ├── review-cache.mjs        # 리뷰 결과 캐시 관리
│   └── config.mjs              # 모델/모드 설정 스크립트
├── tests/
│   ├── review-cache.test.mjs   # review-cache 단위 테스트
│   ├── config.test.mjs         # config 단위 테스트
│   └── plan-review-args.test.mjs # 인자 파싱/프롬프트 테스트
```

- [ ] **Step 3: Commit**

```bash
git add README.md .claude-plugin/plugin.json
git commit -m "chore: bump version to 6.0.0, update README with review modes"
```

---

## Release Checklist (post-implementation, not part of task execution)

구현 완료 후 수동으로 수행:

1. 모든 테스트 통과 확인: `node --test tests/`
2. 수동 smoke test: `/parallel-plan-review` 명령으로 실제 리뷰 동작 확인 (full 모드, delta 모드 재리뷰 체인)
3. Git tag + push (CLAUDE.md의 Release Rules 참조):
   ```bash
   git tag v6.0.0
   git push && git push origin v6.0.0
   ```
