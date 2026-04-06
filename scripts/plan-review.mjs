#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [, , file1, file2] = process.argv;

if (!file1) {
  console.error("Usage: plan-review.mjs <plan-or-spec> [spec-path]");
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

function buildPrompt(planOrSpec, spec) {
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

// Read model from settings.json pluginConfigs
function getConfiguredModel() {
  const settingsPath = join(process.env.HOME || "", ".claude", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return settings?.pluginConfigs?.["second-opinion@second-opinion"]?.options?.model || null;
  } catch {
    return null;
  }
}

// Build prompt and write to temp file
const prompt = buildPrompt(file1, file2);
const tmpDir = mkdtempSync(join(tmpdir(), "codex-plan-review-"));
const promptFile = join(tmpDir, "prompt.txt");
writeFileSync(promptFile, prompt);

// Build command args
const args = [codexScript, "task", "--prompt-file", promptFile];
const model = getConfiguredModel();
if (model) {
  args.push("--model", model);
}

// Spawn codex-companion with inherited stdio (progress + rendering pass through)
const child = spawn("node", args, {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("exit", (code) => {
  try {
    unlinkSync(promptFile);
  } catch {}
  process.exit(code ?? 0);
});
