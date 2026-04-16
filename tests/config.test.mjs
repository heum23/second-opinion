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

function getGateViaSubprocess(fn, home, extraEnv = {}) {
  const output = execSync(
    `node -e "import('./scripts/config.mjs').then(m => console.log(m.${fn}()))"`,
    { encoding: "utf8", cwd: process.cwd(), env: { ...process.env, HOME: home, ...extraEnv } }
  );
  return output.trim();
}

describe("soft-gate / hard-gate subcommand", () => {
  it("shows current values when called with no value", () => {
    const output = execSync("node scripts/config.mjs soft-gate", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("soft gate round"));
  });

  it("sets soft-gate to an integer value", () => {
    const output = execSync("node scripts/config.mjs soft-gate 7", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("7"));
  });

  it("sets hard-gate to zero (disabled message)", () => {
    const output = execSync("node scripts/config.mjs hard-gate 0", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("비활성화"));
  });

  it("accepts negative value as disabled", () => {
    const output = execSync("node scripts/config.mjs soft-gate -5", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("비활성화"));
  });

  it("rejects non-integer soft-gate value", () => {
    try {
      execSync("node scripts/config.mjs soft-gate abc", { encoding: "utf8", cwd: process.cwd(), env });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e.stderr.includes("Invalid") || e.status !== 0);
    }
  });

  it("restores hard-gate to default via 'default' keyword", () => {
    const output = execSync("node scripts/config.mjs hard-gate default", { encoding: "utf8", cwd: process.cwd(), env });
    assert.ok(output.includes("기본값") || output.includes("10"));
  });
});

describe("getSoftGateRound / getHardGateRound exports", () => {
  it("returns defaults 5/10 when no setting exists", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "codex-gate-default-"));
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    writeFileSync(join(tempHome, ".claude", "settings.json"), "{}");
    assert.equal(getGateViaSubprocess("getSoftGateRound", tempHome), "5");
    assert.equal(getGateViaSubprocess("getHardGateRound", tempHome), "10");
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("reads values from settings.json", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "codex-gate-settings-"));
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tempHome, ".claude", "settings.json"),
      JSON.stringify({
        pluginConfigs: {
          "codex-plan-review@codex-plan-review": {
            options: { softGateRound: 3, hardGateRound: 99 },
          },
        },
      })
    );
    assert.equal(getGateViaSubprocess("getSoftGateRound", tempHome), "3");
    assert.equal(getGateViaSubprocess("getHardGateRound", tempHome), "99");
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("honors env var CODEX_PLAN_REVIEW_SOFT_GATE over settings", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "codex-gate-env-"));
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tempHome, ".claude", "settings.json"),
      JSON.stringify({
        pluginConfigs: {
          "codex-plan-review@codex-plan-review": {
            options: { softGateRound: 3 },
          },
        },
      })
    );
    assert.equal(
      getGateViaSubprocess("getSoftGateRound", tempHome, { CODEX_PLAN_REVIEW_SOFT_GATE: "0" }),
      "0"
    );
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("falls back to default when env var is non-numeric", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "codex-gate-envbad-"));
    mkdirSync(join(tempHome, ".claude"), { recursive: true });
    writeFileSync(join(tempHome, ".claude", "settings.json"), "{}");
    assert.equal(
      getGateViaSubprocess("getHardGateRound", tempHome, { CODEX_PLAN_REVIEW_HARD_GATE: "notanumber" }),
      "10"
    );
    rmSync(tempHome, { recursive: true, force: true });
  });
});
