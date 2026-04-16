import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { resolveWorkspace, buildSpawnArgs, prepareSpawn } from "../scripts/plan-review.mjs";

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
