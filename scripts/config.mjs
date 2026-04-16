#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SETTINGS_PATH = join(process.env.HOME || "", ".claude", "settings.json");
const PLUGIN_KEY = "codex-plan-review@codex-plan-review";
const VALID_MODES = ["full", "delta", "focused"];

// Gate defaults. A value of 0 or any negative number disables the gate.
// Resolution order: env var > ~/.claude/settings.json > default.
export const DEFAULT_SOFT_GATE_ROUND = 5;
export const DEFAULT_HARD_GATE_ROUND = 10;
const ENV_SOFT_GATE = "CODEX_PLAN_REVIEW_SOFT_GATE";
const ENV_HARD_GATE = "CODEX_PLAN_REVIEW_HARD_GATE";

function parseGateValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return n;
}

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

export function getSoftGateRound(settings) {
  const envValue = process.env[ENV_SOFT_GATE];
  if (envValue !== undefined && envValue !== "") {
    return parseGateValue(envValue, DEFAULT_SOFT_GATE_ROUND);
  }
  const stored = getOptions(settings || readSettings()).softGateRound;
  if (stored !== undefined) {
    return parseGateValue(stored, DEFAULT_SOFT_GATE_ROUND);
  }
  return DEFAULT_SOFT_GATE_ROUND;
}

export function setSoftGateRound(settings, value) {
  const n = parseGateValue(value, NaN);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid soft gate value: ${value} (must be an integer; use 0 or negative to disable)`);
  }
  const opts = ensureOptions(settings);
  opts.softGateRound = n;
  save(settings);
  return n;
}

export function getHardGateRound(settings) {
  const envValue = process.env[ENV_HARD_GATE];
  if (envValue !== undefined && envValue !== "") {
    return parseGateValue(envValue, DEFAULT_HARD_GATE_ROUND);
  }
  const stored = getOptions(settings || readSettings()).hardGateRound;
  if (stored !== undefined) {
    return parseGateValue(stored, DEFAULT_HARD_GATE_ROUND);
  }
  return DEFAULT_HARD_GATE_ROUND;
}

export function setHardGateRound(settings, value) {
  const n = parseGateValue(value, NaN);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid hard gate value: ${value} (must be an integer; use 0 or negative to disable)`);
  }
  const opts = ensureOptions(settings);
  opts.hardGateRound = n;
  save(settings);
  return n;
}

// Only run CLI logic when executed directly (not imported as module)
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  runCli();
}

function describeGate(value, defaultValue) {
  if (value <= 0) return `disabled (${value})`;
  if (value === defaultValue) return `${value} (기본값)`;
  return `${value}`;
}

function runCli() {
  const [subcommand, value] = process.argv.slice(2);
  const settings = readSettings();

  if (!subcommand) {
    const model = getCurrentModel(settings);
    const mode = getReviewMode(settings);
    const softGate = getSoftGateRound(settings);
    const hardGate = getHardGateRound(settings);
    console.log(`현재 모델: ${model || "기본값"}`);
    console.log(`현재 리뷰 모드: ${mode}`);
    console.log(`현재 soft gate round: ${describeGate(softGate, DEFAULT_SOFT_GATE_ROUND)}`);
    console.log(`현재 hard gate round: ${describeGate(hardGate, DEFAULT_HARD_GATE_ROUND)}`);
    console.log(`\n사용법:`);
    console.log(`  /plan-reviewer-change model <모델명>      모델 변경`);
    console.log(`  /plan-reviewer-change model default       기본값 복원`);
    console.log(`  /plan-reviewer-change mode <모드>         리뷰 모드 변경 (full, delta, focused)`);
    console.log(`  /plan-reviewer-change soft-gate <N>       Soft gate round (0 이하 = 비활성화, 기본 ${DEFAULT_SOFT_GATE_ROUND})`);
    console.log(`  /plan-reviewer-change hard-gate <N>       Hard gate round (0 이하 = 비활성화, 기본 ${DEFAULT_HARD_GATE_ROUND})`);
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
  } else if (subcommand === "soft-gate") {
    if (!value) {
      console.log(`현재 soft gate round: ${describeGate(getSoftGateRound(settings), DEFAULT_SOFT_GATE_ROUND)}`);
      process.exit(0);
    }
    if (value === "default") {
      const opts = ensureOptions(settings);
      delete opts.softGateRound;
      save(settings);
      console.log(`✓ Soft gate가 기본값(${DEFAULT_SOFT_GATE_ROUND})으로 복원되었습니다.`);
      process.exit(0);
    }
    try {
      const n = setSoftGateRound(settings, value);
      if (n <= 0) {
        console.log(`✓ Soft gate가 비활성화되었습니다 (${n}). Codex는 hard gate 전까지 사용자 확인 없이 자동 반복됩니다.`);
      } else {
        console.log(`✓ Soft gate round가 ${n}로 변경되었습니다.`);
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else if (subcommand === "hard-gate") {
    if (!value) {
      console.log(`현재 hard gate round: ${describeGate(getHardGateRound(settings), DEFAULT_HARD_GATE_ROUND)}`);
      process.exit(0);
    }
    if (value === "default") {
      const opts = ensureOptions(settings);
      delete opts.hardGateRound;
      save(settings);
      console.log(`✓ Hard gate가 기본값(${DEFAULT_HARD_GATE_ROUND})으로 복원되었습니다.`);
      process.exit(0);
    }
    try {
      const n = setHardGateRound(settings, value);
      if (n <= 0) {
        console.log(`✓ Hard gate가 비활성화되었습니다 (${n}). 자동 반복이 무제한으로 허용됩니다 — 주의해서 사용하세요.`);
      } else {
        console.log(`✓ Hard gate round가 ${n}로 변경되었습니다.`);
      }
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
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
  }
}
