#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { getReviewMode, getCurrentModel, getSoftGateRound, getHardGateRound } from "./config.mjs";
import { normalizePath, findPreviousReview, extractIssuesSummary, saveReview } from "./review-cache.mjs";

// Marker state machine, shared with hooks/plan-review-trigger.py.
// On successful review completion we flip state to REVIEWED and bump round,
// so the next Write/Edit of the same document fires the next round via the
// hook instead of being suppressed as PENDING_REVIEW.
//
// Gate defaults come from config (env var > ~/.claude/settings.json > hardcoded
// default 5/10). A value of 0 or any negative number disables the corresponding
// gate at hook-check time.
const MARKER_DIR = "/tmp";

export function reviewMarkerPath(filePath) {
  const hash = createHash("sha256").update(filePath).digest("hex");
  return `${MARKER_DIR}/codex-plan-review-${hash}.json`;
}

export function markReviewCompleted(filePath) {
  try {
    const markerPath = reviewMarkerPath(filePath);
    let marker = {
      state: "PENDING_REVIEW",
      round: 0,
      soft_gate_round: getSoftGateRound(),
      hard_gate_round: getHardGateRound(),
    };
    if (existsSync(markerPath)) {
      try {
        const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
        if (parsed && typeof parsed === "object") {
          marker = { ...marker, ...parsed };
        }
      } catch {
        // Corrupted marker — fall through and overwrite with defaults.
      }
    }
    // Refresh gate values from config on every completion so that a user
    // changing /plan-reviewer-change soft-gate 0 mid-session takes effect
    // on the next hook fire without needing to delete the marker.
    marker.soft_gate_round = getSoftGateRound();
    marker.hard_gate_round = getHardGateRound();
    marker.state = "REVIEWED";
    marker.round = (Number(marker.round) || 0) + 1;
    writeFileSync(markerPath, JSON.stringify(marker));
    return marker;
  } catch (err) {
    // Never let marker update failure break the review pipeline.
    console.error(`Warning: failed to update review marker: ${err.message}`);
    return null;
  }
}

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

export function resolveWorkspace(cliCwd, files) {
  const baseDir = cliCwd ? resolve(process.cwd(), cliCwd) : process.cwd();
  const resolvedFiles = files.map((f) => resolve(baseDir, f));
  const cwdCandidate = cliCwd ? baseDir : dirname(resolvedFiles[0]);
  const workspace = detectGitRoot(cwdCandidate) ?? cwdCandidate;
  return { workspace, resolvedFiles };
}

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

const VALID_MODES = ["full", "delta", "focused"];

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

// Returns the mode to actually use, falling back to "full" when delta/focused has no valid baseline.
export function resolveMode(requestedMode, previousReview) {
  if (requestedMode === "full") return "full";
  if (!previousReview) return "full";
  if (previousReview.parseSuccess === false) return "full";
  if (!previousReview.issues || previousReview.issues.length === 0) return "full";
  return requestedMode;
}

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
  const { mode: cliMode } = parsed;

  if (parsed.files.length === 0) {
    console.error("Usage: plan-review.mjs [--mode full|delta|focused] [--cwd <path>] <plan-or-spec> [spec-path]");
    process.exit(1);
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

  // Resolve workspace and file paths
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

  // Model, tmpDir, spawnArgs
  const model = getCurrentModel();
  const tmpDir = mkdtempSync(join(tmpdir(), "codex-plan-review-"));
  const promptFile = join(tmpDir, "prompt.txt");
  const spawnArgs = buildSpawnArgs(codexScript, workspace, promptFile, model);

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
  writeFileSync(promptFile, prompt);

  process.stderr.write(`[plan-review] workspace = ${workspace}\n`);

  // Spawn codex-companion: pipe stdout for tee capture, pipe stderr for filtering
  const stdoutChunks = [];
  const child = spawn("node", spawnArgs, {
    stdio: ["inherit", "pipe", "pipe"],
    cwd: workspace,
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

  // Handle spawn errors (ENOENT, EMFILE, etc.) — prevents tmp file leak
  child.on("error", (err) => {
    console.error(`Failed to spawn codex-companion: ${err.message}`);
    try { unlinkSync(promptFile); } catch {}
    // Save an empty review so parseSuccess: false is recorded, enabling full-mode fallback next run
    try { saveReview(normalizedPath, "", resolvedMode, previousReview); } catch {}
    process.exit(1);
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
    try {
      const rawOutput = Buffer.concat(stdoutChunks).toString("utf8");
      saveReview(normalizedPath, rawOutput, resolvedMode, previousReview);
    } catch (err) {
      console.error(`Warning: failed to save review to cache: ${err.message}`);
    }

    // Advance the state-machine marker only on successful completion.
    // Failures leave the marker in PENDING_REVIEW so a manual re-run or the
    // next auto-trigger can retry the same round without burning the budget.
    if (exitCode === 0) {
      markReviewCompleted(file1);
    }

    process.exit(exitCode);
  });
}
