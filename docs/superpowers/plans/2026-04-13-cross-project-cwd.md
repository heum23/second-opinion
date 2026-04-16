# Cross-Project cwd Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `plan-review.mjs`에 `--cwd` 플래그와 git root 자동 감지를 추가하여, 호출자 프로젝트와 다른 프로젝트의 plan/spec 파일을 Codex가 올바른 workspace로 리뷰할 수 있게 한다.

**Architecture:** `parseArgs`에 `--cwd`/`-C` 옵션을 추가하고, 새 함수 `detectGitRoot`/`resolveWorkspace`/`buildSpawnArgs`/`prepareSpawn`으로 workspace와 spawn 인자를 결정한다. `main()`은 `prepareSpawn` 반환값으로 spawn을 호출하는 얇은 wiring만 담당한다. Hook은 수정하지 않는다 — 기존 절대경로 기반 자동 감지로 충분하다.

**Tech Stack:** Node.js (ESM), `node:test` (test runner), `node:child_process` (`execSync` for git), `node:path`

**Spec:** `docs/superpowers/specs/2026-04-10-cross-project-cwd-design.md`

---

## File Structure

| 파일 | 역할 | 변경 |
|---|---|---|
| `scripts/plan-review.mjs` | 메인 스크립트 | `parseArgs` 확장, `detectGitRoot`/`resolveWorkspace`/`buildSpawnArgs`/`prepareSpawn` 추가, `main()` wiring 수정 |
| `tests/plan-review-args.test.mjs` | parseArgs 테스트 | `--cwd` 파싱 케이스 추가 |
| `tests/plan-review-workspace.test.mjs` | 신규 | `resolveWorkspace`/`buildSpawnArgs`/`prepareSpawn` 단위 테스트 |
| `commands/parallel-plan-review.md` | 수동 리뷰 command | `--cwd` 플래그 문서화 |
| `README.md` | 프로젝트 문서 | cross-project 사용 예시 추가 |
| `.claude-plugin/plugin.json` | 플러그인 메타 | 버전 6.4.0 |

---

### Task 1: `parseArgs`에 `--cwd`/`-C` 파싱 추가

**Files:**
- Modify: `tests/plan-review-args.test.mjs` (line 187 뒤에 새 describe 추가)
- Modify: `scripts/plan-review.mjs:63-88` (`parseArgs` 함수)

- [ ] **Step 1: Write failing tests for `--cwd` parsing**

`tests/plan-review-args.test.mjs` 파일 맨 끝(line 188, `markReviewCompleted` describe 블록 뒤)에 추가:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/plan-review-args.test.mjs 2>&1 | tail -20`
Expected: 5 new tests FAIL — `result.cwd` is `undefined`

- [ ] **Step 3: Implement `--cwd` parsing in `parseArgs`**

`scripts/plan-review.mjs` — `parseArgs` 함수(line 63-88)를 수정. `let mode = null;` (line 65) 뒤에 `let cwd = null;`을 추가하고, for 루프 안에 `--cwd`/`-C` 분기를 넣고, 반환값에 `cwd`를 포함한다.

```js
export function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = null;
  let cwd = null;
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
      i++;
    } else if (args[i] === "--cwd" || args[i] === "-C") {
      if (i + 1 >= args.length) {
        throw new Error("--cwd requires a value");
      }
      cwd = args[i + 1];
      i++;
    } else {
      files.push(args[i]);
    }
  }

  if (files.length > 2) {
    throw new Error(`Too many file arguments (max 2, got ${files.length}): ${files.join(", ")}`);
  }

  return { mode, cwd, files };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/plan-review-args.test.mjs 2>&1 | tail -10`
Expected: All 25 tests PASS (기존 20 + 신규 5)

- [ ] **Step 5: Commit**

```bash
git add tests/plan-review-args.test.mjs scripts/plan-review.mjs
git commit -m "feat: add --cwd/-C flag to parseArgs"
```

---

### Task 2: `detectGitRoot` 헬퍼 및 테스트 scaffold 추가

**Files:**
- Create: `tests/plan-review-workspace.test.mjs`
- Modify: `scripts/plan-review.mjs:5` (import 확장)
- Modify: `scripts/plan-review.mjs` (함수 추가, `VALID_MODES` 선언인 line 61 바로 위에)

- [ ] **Step 1: Write test scaffold**

`tests/plan-review-workspace.test.mjs` 파일을 새로 생성:

```js
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// NOTE: imports are added incrementally per task.
// Task 2 creates this file with fixtures only — no API imports yet.
// Task 3 adds: import { resolveWorkspace } from "../scripts/plan-review.mjs";
// Task 4 adds: import { resolveWorkspace, buildSpawnArgs, prepareSpawn } from "../scripts/plan-review.mjs";

let gitRepoRoot;
let gitSubDir;
let gitSubFile;
let nonGitDir;
let nonGitFile;

before(() => {
  gitRepoRoot = mkdtempSync(join(tmpdir(), "cwd-test-git-"));
  execSync("git init", { cwd: gitRepoRoot, stdio: "ignore" });
  gitSubDir = join(gitRepoRoot, "docs", "superpowers", "specs");
  mkdirSync(gitSubDir, { recursive: true });
  gitSubFile = join(gitSubDir, "test-plan.md");
  writeFileSync(gitSubFile, "# Test Plan");

  nonGitDir = mkdtempSync(join(tmpdir(), "cwd-test-nogit-"));
  nonGitFile = join(nonGitDir, "plan.md");
  writeFileSync(nonGitFile, "# Plan");
});

after(() => {
  rmSync(gitRepoRoot, { recursive: true, force: true });
  rmSync(nonGitDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test file to verify module loads**

Run: `node --test tests/plan-review-workspace.test.mjs 2>&1 | tail -10`
Expected: 0 tests, exit code 0. This is strictly a module-load check — it confirms the file parses and imports resolve without errors. No fixture assertions exist yet; all fixture validation happens in Task 3 when `resolveWorkspace` tests exercise the created paths.

- [ ] **Step 3: Add `dirname` to import and implement `detectGitRoot`**

`scripts/plan-review.mjs` — line 5의 import를 수정:

```js
import { dirname, join, resolve } from "node:path";
```

`VALID_MODES` 선언(line 61) 바로 위에 `detectGitRoot`를 추가:

```js
function detectGitRoot(dir) {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `node --test tests/plan-review-args.test.mjs 2>&1 | tail -5`
Expected: All 25 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan-review.mjs tests/plan-review-workspace.test.mjs
git commit -m "feat: add detectGitRoot helper and workspace test scaffold"
```

---

### Task 3: `resolveWorkspace` 함수 추가

**Files:**
- Modify: `tests/plan-review-workspace.test.mjs` (테스트 추가)
- Modify: `scripts/plan-review.mjs` (`detectGitRoot` 바로 뒤에 함수 추가 + export)

- [ ] **Step 1: Add import and write failing tests for `resolveWorkspace`**

`tests/plan-review-workspace.test.mjs`의 fixture 주석("imports are added incrementally") 자리에 실제 import를 추가:

```js
import { resolveWorkspace } from "../scripts/plan-review.mjs";
```

그리고 `after()` 블록 뒤에 다음 테스트를 추가:

```js
describe("resolveWorkspace", () => {
  it("auto-detect: git repo file resolves workspace to repo root", () => {
    const { workspace, resolvedFiles } = resolveWorkspace(null, [gitSubFile]);
    assert.equal(workspace, gitRepoRoot);
    assert.equal(resolvedFiles[0], gitSubFile);
    assert.notEqual(workspace, gitSubDir);
  });

  it("auto-detect: non-git file resolves workspace to dirname", () => {
    const { workspace, resolvedFiles } = resolveWorkspace(null, [nonGitFile]);
    assert.equal(workspace, nonGitDir);
    assert.equal(resolvedFiles[0], nonGitFile);
    assert.notEqual(workspace, process.cwd());
  });

  it("--cwd explicit: promotes git subdir to repo root", () => {
    const { workspace, resolvedFiles } = resolveWorkspace(gitSubDir, ["test-plan.md"]);
    assert.equal(workspace, gitRepoRoot);
    assert.equal(resolvedFiles[0], join(gitSubDir, "test-plan.md"));
  });

  it("--cwd explicit: non-git dir stays as-is", () => {
    const { workspace, resolvedFiles } = resolveWorkspace(nonGitDir, ["plan.md"]);
    assert.equal(workspace, nonGitDir);
    assert.equal(resolvedFiles[0], join(nonGitDir, "plan.md"));
  });

  it("--cwd explicit: two files resolved relative to cwd", () => {
    const { workspace, resolvedFiles } = resolveWorkspace(gitSubDir, ["test-plan.md", "other.md"]);
    assert.equal(workspace, gitRepoRoot);
    assert.equal(resolvedFiles[0], join(gitSubDir, "test-plan.md"));
    assert.equal(resolvedFiles[1], join(gitSubDir, "other.md"));
  });

  it("auto-detect: relative file path resolved and workspace promoted", () => {
    // Temporarily chdir into the git repo so relative paths work deterministically
    const originalCwd = process.cwd();
    try {
      process.chdir(gitRepoRoot);
      const relPath = "docs/superpowers/specs/test-plan.md";
      const { workspace, resolvedFiles } = resolveWorkspace(null, [relPath]);
      assert.equal(resolvedFiles[0], join(gitRepoRoot, relPath));
      assert.equal(workspace, gitRepoRoot);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("--cwd with relative path resolved against process.cwd() then promoted", () => {
    // Temporarily chdir to parent of git repo so ./repoName is a valid relative --cwd
    const originalCwd = process.cwd();
    const parentDir = join(gitRepoRoot, "..");
    const repoName = gitRepoRoot.split("/").pop();
    try {
      process.chdir(parentDir);
      const { workspace } = resolveWorkspace(`./${repoName}/docs/superpowers/specs`, ["test-plan.md"]);
      assert.equal(workspace, gitRepoRoot);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/plan-review-workspace.test.mjs 2>&1 | tail -15`
Expected: FAIL — `resolveWorkspace` is not a function

- [ ] **Step 3: Implement `resolveWorkspace`**

`scripts/plan-review.mjs` — `detectGitRoot` 함수 바로 뒤에 추가:

```js
export function resolveWorkspace(cliCwd, files) {
  const baseDir = cliCwd ? resolve(process.cwd(), cliCwd) : process.cwd();
  const resolvedFiles = files.map((f) => resolve(baseDir, f));
  const cwdCandidate = cliCwd ? baseDir : dirname(resolvedFiles[0]);
  const workspace = detectGitRoot(cwdCandidate) ?? cwdCandidate;
  return { workspace, resolvedFiles };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/plan-review-workspace.test.mjs 2>&1 | tail -10`
Expected: All 7 tests PASS

Run: `node --test tests/plan-review-args.test.mjs 2>&1 | tail -5`
Expected: All 25 tests PASS (회귀 없음)

- [ ] **Step 5: Commit**

```bash
git add scripts/plan-review.mjs tests/plan-review-workspace.test.mjs
git commit -m "feat: add resolveWorkspace with git root auto-detect"
```

---

### Task 4: `buildSpawnArgs` 및 `prepareSpawn` 함수 추가

**Files:**
- Modify: `tests/plan-review-workspace.test.mjs` (테스트 추가)
- Modify: `scripts/plan-review.mjs` (`resolveWorkspace` 뒤에 함수 추가 + export)

- [ ] **Step 1: Extend import and write failing tests for `buildSpawnArgs` and `prepareSpawn`**

`tests/plan-review-workspace.test.mjs`의 import를 확장:

```js
import { resolveWorkspace, buildSpawnArgs, prepareSpawn } from "../scripts/plan-review.mjs";
```

`resolveWorkspace` describe 뒤에 테스트 추가:

```js
describe("buildSpawnArgs", () => {
  it("builds args without model", () => {
    const args = buildSpawnArgs("/path/to/codex.mjs", "/workspace", "/tmp/prompt.txt", null);
    assert.deepEqual(args, ["/path/to/codex.mjs", "task", "--cwd", "/workspace", "--prompt-file", "/tmp/prompt.txt"]);
  });

  it("appends --model when provided", () => {
    const args = buildSpawnArgs("/path/to/codex.mjs", "/ws", "/tmp/p.txt", "o3");
    assert.deepEqual(args, ["/path/to/codex.mjs", "task", "--cwd", "/ws", "--prompt-file", "/tmp/p.txt", "--model", "o3"]);
  });

  it("places workspace as 4th element (--cwd value)", () => {
    const args = buildSpawnArgs("x", "/my/workspace", "y", null);
    assert.equal(args[3], "/my/workspace");
  });
});

describe("prepareSpawn", () => {
  it("wires parseArgs output to resolveWorkspace and buildSpawnArgs (auto-detect)", () => {
    const parsed = { mode: null, cwd: null, files: [gitSubFile] };
    const result = prepareSpawn(parsed, "/codex.mjs", "/tmp/prompt.txt", null);
    assert.equal(result.workspace, gitRepoRoot);
    assert.equal(result.resolvedFiles[0], gitSubFile);
    assert.equal(result.spawnArgs[3], gitRepoRoot);
    assert.equal(result.spawnArgs[5], "/tmp/prompt.txt");
  });

  it("wires parseArgs output with explicit --cwd (git subdir promotes)", () => {
    const parsed = { mode: null, cwd: gitSubDir, files: ["test-plan.md"] };
    const result = prepareSpawn(parsed, "/codex.mjs", "/tmp/p.txt", null);
    assert.equal(result.workspace, gitRepoRoot);
    assert.equal(result.spawnArgs[3], gitRepoRoot);
  });

  it("wires parseArgs output with non-git --cwd", () => {
    const parsed = { mode: null, cwd: nonGitDir, files: ["plan.md"] };
    const result = prepareSpawn(parsed, "/codex.mjs", "/tmp/p.txt", null);
    assert.equal(result.workspace, nonGitDir);
    assert.equal(result.spawnArgs[3], nonGitDir);
  });

  it("includes model in spawnArgs when provided", () => {
    const parsed = { mode: null, cwd: null, files: [gitSubFile] };
    const result = prepareSpawn(parsed, "/codex.mjs", "/tmp/p.txt", "spark");
    assert.equal(result.spawnArgs[result.spawnArgs.length - 1], "spark");
    assert.equal(result.spawnArgs[result.spawnArgs.length - 2], "--model");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/plan-review-workspace.test.mjs 2>&1 | tail -15`
Expected: FAIL — `buildSpawnArgs` and `prepareSpawn` are not functions

- [ ] **Step 3: Implement `buildSpawnArgs` and `prepareSpawn`**

`scripts/plan-review.mjs` — `resolveWorkspace` 뒤에 추가:

```js
export function buildSpawnArgs(codexScript, workspace, promptFile, model) {
  const args = [codexScript, "task", "--cwd", workspace, "--prompt-file", promptFile];
  if (model) args.push("--model", model);
  return args;
}

export function prepareSpawn(parsed, codexScript, promptFile, model) {
  const { cwd: cliCwd, files } = parsed;
  const { workspace, resolvedFiles } = resolveWorkspace(cliCwd, files);
  const args = buildSpawnArgs(codexScript, workspace, promptFile, model);
  return { workspace, resolvedFiles, spawnArgs: args };
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `node --test tests/plan-review-workspace.test.mjs 2>&1 | tail -10`
Expected: All 14 tests PASS (resolveWorkspace 7 + buildSpawnArgs 3 + prepareSpawn 4)

Run: `node --test tests/plan-review-args.test.mjs 2>&1 | tail -5`
Expected: All 25 tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/plan-review.mjs tests/plan-review-workspace.test.mjs
git commit -m "feat: add buildSpawnArgs and prepareSpawn"
```

---

### Task 5: `main()` wiring 수정

**Files:**
- Modify: `scripts/plan-review.mjs:286-420` (`main()` 함수)

> 주의: main()의 close handler에 있는 `markReviewCompleted(file1)` (line 416)은 수정 불필요. `file1`이 `const [file1, file2] = resolvedFiles;`에서 할당되므로 이미 절대경로이고 마커 hash가 hook과 일관된다.

- [ ] **Step 1: Update `main()` to use `prepareSpawn` and `resolvedFiles`**

`scripts/plan-review.mjs`의 `main()` 함수(line 286 시작)를 수정. 변경 부분만 명시:

**line 294** (parseArgs 결과 분해) — 기존:

```js
  const { mode: cliMode, files } = parsed;
  const [file1, file2] = files;
```

변경:

```js
  const { mode: cliMode } = parsed;
```

**line 297-300** (usage 체크) — 기존:

```js
  if (!file1) {
    console.error("Usage: plan-review.mjs [--mode full|delta|focused] <plan-or-spec> [spec-path]");
    process.exit(1);
  }
```

변경:

```js
  if (parsed.files.length === 0) {
    console.error("Usage: plan-review.mjs [--mode full|delta|focused] [--cwd <path>] <plan-or-spec> [spec-path]");
    process.exit(1);
  }
```

**line 302-310** (existsSync 체크) — 삭제. prepareSpawn 후로 이동.

**codex 스크립트 찾기 블록(line 333-347)은 그대로 유지.**

codex 스크립트를 찾은 직후(line 347 뒤), 기존 existsSync 블록 + args 생성(line 302-354) 자리를 다음 순서로 재구성한다. 핵심: `resolveWorkspace` → file validation → `mkdtempSync` → `buildSpawnArgs` 순서로, file not found 시 불필요한 tmpDir 생성을 방지한다.

```js
  // Step 4-6: resolve workspace, validate files
  const { workspace, resolvedFiles } = resolveWorkspace(parsed.cwd, parsed.files);
  const [file1, file2] = resolvedFiles;

  if (!existsSync(file1)) {
    console.error(`File not found: ${file1}`);
    process.exit(1);
  }

  if (file2 && !existsSync(file2)) {
    console.error(`File not found: ${file2}`);
    process.exit(1);
  }

  // Step 7-9: model, tmpDir, spawnArgs
  const model = getCurrentModel();
  const tmpDir = mkdtempSync(join(tmpdir(), "codex-plan-review-"));
  const promptFile = join(tmpDir, "prompt.txt");
  const spawnArgs = buildSpawnArgs(codexScript, workspace, promptFile, model);
```

> 참고: `prepareSpawn`은 `resolveWorkspace` + `buildSpawnArgs`를 조합하는 편의 함수로 export/테스트 대상으로 남기지만, `main()`에서는 file validation과 mkdtempSync 사이에 끼워야 하므로 분리 호출한다.

**기존 cache/mode/prompt 블록(line 312-331)** — `filePaths` 대신 resolvedFiles 사용. 기존 `tmpDir`/`promptFile`/`writeFileSync` 줄 삭제(이미 위에서 생성). 남는 부분:

```js
  const normalizedPath = normalizePath(...(file2 ? [file1, file2] : [file1]));
  const previousReview = findPreviousReview(normalizedPath);
  const settingsMode = getReviewMode();
  const requestedMode = cliMode || settingsMode;
  const resolvedMode = resolveMode(requestedMode, previousReview);
  const issuesSummary = resolvedMode !== "full" ? extractIssuesSummary(previousReview) : null;
  const prompt = buildPrompt(file1, file2, resolvedMode, issuesSummary);
  writeFileSync(promptFile, prompt);
```

**기존 args + model 블록(line 349-354)과 spawn 블록(line 357-361)** — 전체 교체:

```js
  process.stderr.write(`[plan-review] workspace = ${workspace}\n`);

  const stdoutChunks = [];
  const child = spawn("node", spawnArgs, {
    stdio: ["inherit", "pipe", "pipe"],
    cwd: workspace,
  });
```

나머지(stream handlers, error/exit/close handlers, `markReviewCompleted(file1)`)는 **변경 없음**.

- [ ] **Step 2: Run all tests to verify no regression**

Run: `node --test tests/plan-review-args.test.mjs tests/plan-review-workspace.test.mjs 2>&1 | tail -10`
Expected: All 39 tests PASS (args 25 + workspace 14)

- [ ] **Step 3: Commit**

```bash
git add scripts/plan-review.mjs
git commit -m "feat: wire resolveWorkspace/buildSpawnArgs into main() for cross-project cwd"
```

---

### Task 6: 문서 업데이트

**Files:**
- Modify: `commands/parallel-plan-review.md`
- Modify: `README.md:89-95`

- [ ] **Step 1: Update `commands/parallel-plan-review.md`**

전체를 다음으로 교체:

```markdown
---
name: parallel-plan-review
description: Plan/Spec 파일을 수동으로 Codex 리뷰 요청 (파일 경로 전달, --mode/--cwd 지원)
argument-hint: '[--mode full|delta|focused] [--cwd <path>] <plan-or-spec-path> [spec-path]'
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

# Cross-project review (다른 프로젝트의 파일을 리뷰)
/parallel-plan-review /home/user/other-project/docs/superpowers/plans/foo.md
/parallel-plan-review --cwd /home/user/other-project docs/superpowers/plans/foo.md
```

### Options

- `--mode <value>`: 리뷰 모드 (`full`, `delta`, `focused`)
- `--cwd <path>` / `-C <path>`: Codex workspace 경로. 생략 시 파일 위치의 git root를 자동 감지.

### Review Modes

- **delta** (default): 이전 리뷰 이슈 해결 여부 확인 + 새 이슈 탐색. 이전 리뷰 없으면 full fallback.
- **full**: 전체 리뷰 (이전 리뷰 무시)
- **focused**: 이전 리뷰 이슈 재검증만, 새 이슈 탐색 없음. 이전 리뷰 없으면 full fallback.

### Instructions

1. **Resolve arguments**: The user provided: `$ARGUMENTS`
   - Extract `--mode <value>` if present (can appear anywhere in arguments). Valid values: `full`, `delta`, `focused`.
   - Extract `--cwd <path>` or `-C <path>` if present.
   - Remaining arguments are file paths.
   - If TWO paths given: first is plan, second is spec
   - If ONE path given and it contains `/plans/`: it's a plan — check for corresponding spec by replacing `/plans/` with `/specs/`. **If `--cwd` was provided, resolve the spec path relative to `--cwd` (not the caller project).** For absolute plan paths, the replacement produces an absolute spec path directly.
   - If ONE path given and it contains `/specs/`: it's a spec only
   - If no file arguments given: use Glob to find the most recently modified `docs/superpowers/{plans,specs}/*.md` file and confirm with user

2. **Run the Codex review** as a Bash call:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-review.mjs" [--mode <mode>] [--cwd <path>] "<file1>" ["<file2>"]
   ```
   Set Bash timeout to **600000** (10 minutes).

3. **Process results**: Read the Codex review output. If issues are found, fix them with Edit, then re-run the review to confirm.
```

- [ ] **Step 2: Update `README.md`**

`README.md`의 `/parallel-plan-review` 명령어 코드 블록(line 89-95)을 다음으로 교체:

```bash
/parallel-plan-review docs/superpowers/plans/my-plan.md                    # 계획 리뷰 (대응 스펙 자동 탐색)
/parallel-plan-review docs/superpowers/plans/my-plan.md my-spec.md         # 계획 + 스펙 교차 리뷰
/parallel-plan-review docs/superpowers/specs/my-spec.md                    # 스펙 리뷰
/parallel-plan-review                                                       # 최근 수정된 파일 자동 탐색
/parallel-plan-review docs/superpowers/specs/my-spec.md --mode full        # 모드 오버라이드
/parallel-plan-review /path/to/other-proj/docs/superpowers/plans/foo.md    # 다른 프로젝트 리뷰
/parallel-plan-review --cwd /path/to/other-proj docs/superpowers/plans/foo.md  # --cwd로 workspace 지정
```

- [ ] **Step 3: Run all tests one more time**

Run: `node --test tests/plan-review-args.test.mjs tests/plan-review-workspace.test.mjs tests/review-cache.test.mjs tests/config.test.mjs 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add commands/parallel-plan-review.md README.md
git commit -m "docs: add --cwd flag to command docs and README"
```

---

### Task 7: 수동 검증

> Spec의 `수동 검증` 섹션에 정의된 5개 시나리오. 자동화 테스트 범위 밖인 main() I/O 경계를 덮는 보완책이다. 릴리즈 전에 반드시 수행한다.

- [ ] **Step 1: Cross-project 절대경로 호출** — 2번 프로젝트 plan 파일을 절대경로로 수동 호출. `[plan-review] workspace = <2번 프로젝트 git root>` 로그 확인.
- [ ] **Step 2: `--cwd` override + 하위 디렉토리 승격** — git repo 하위 디렉토리를 `--cwd`로 지정. 로그가 repo root(하위 디렉토리 아님)인지 확인.
- [ ] **Step 3: Hook 경유 자동 리뷰** — 1번 프로젝트에서 Write로 2번 프로젝트 plan 저장. hook 발동 → 2번 프로젝트 workspace 로그 확인.
- [ ] **Step 4: 기존 케이스 회귀** — 1번 프로젝트 내부 plan 리뷰. 기존과 동일 동작 확인.
- [ ] **Step 5: Non-git fallback** — `/tmp/some-dir/plan.md` 리뷰. workspace가 `/tmp/some-dir`인지 확인.

---

### Task 8: 릴리즈

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Bump version in `plugin.json`**

`.claude-plugin/plugin.json`의 `"version"` 값을 `"6.3.0"`에서 `"6.4.0"`으로 변경.

- [ ] **Step 2: Commit and release**

```bash
git add .claude-plugin/plugin.json
git commit -m "chore: bump version to 6.4.0"
git push
git tag v6.4.0
git push origin v6.4.0
```
