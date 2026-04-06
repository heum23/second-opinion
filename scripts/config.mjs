#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS_PATH = join(process.env.HOME || "", ".claude", "settings.json");
const PLUGIN_KEY = "second-opinion@second-opinion";

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getCurrentModel(settings) {
  return settings?.pluginConfigs?.[PLUGIN_KEY]?.options?.model || null;
}

function saveModel(settings, model) {
  if (!settings.pluginConfigs) settings.pluginConfigs = {};
  if (!settings.pluginConfigs[PLUGIN_KEY]) settings.pluginConfigs[PLUGIN_KEY] = {};
  if (!settings.pluginConfigs[PLUGIN_KEY].options) settings.pluginConfigs[PLUGIN_KEY].options = {};

  if (model === null) {
    delete settings.pluginConfigs[PLUGIN_KEY].options.model;
  } else {
    settings.pluginConfigs[PLUGIN_KEY].options.model = model;
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

const arg = process.argv[2]?.trim();
const settings = readSettings();
const current = getCurrentModel(settings);

if (!arg) {
  console.log(`현재 모델: ${current || "기본값"}`);
  console.log(`\n사용법: /plan-reviewer-change <model>`);
  console.log(`  default       Codex CLI 기본 모델`);
  console.log(`  spark         gpt-5.3-codex-spark (경량, 빠름)`);
  console.log(`  gpt-5.4-mini  경량 모델`);
  console.log(`  <모델명>      직접 지정`);
  process.exit(0);
}

if (arg === "default") {
  saveModel(settings, null);
  console.log("✓ 기본값으로 변경되었습니다.");
} else {
  saveModel(settings, arg);
  console.log(`✓ 모델이 "${arg}"으로 변경되었습니다.`);
}
