// scripts/review-cache.mjs
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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
  // For collision-suffixed files with the same timestamp, sort the base file before suffixed ones
  // (base = first write, -1 = second write, -2 = third write, etc.) so that iterating from the
  // end returns the most recently written file.
  // Note: lexicographic sort puts '-1.json' before '.json' ('-' < '.'), so we use a custom sort
  // that extracts the numeric suffix and sorts it numerically after the timestamp key.
  files.sort((a, b) => {
    // Extract: <timestamp>-<hash> as the base key, and optional numeric suffix
    const parseFile = (f) => {
      const withoutExt = f.slice(0, -5); // remove ".json"
      const suffixMatch = withoutExt.match(/-(\d+)$/);
      if (suffixMatch) {
        return { base: withoutExt.slice(0, -suffixMatch[0].length), n: parseInt(suffixMatch[1], 10) };
      }
      return { base: withoutExt, n: 0 };
    };
    const pa = parseFile(a);
    const pb = parseFile(b);
    if (pa.base !== pb.base) return pa.base < pb.base ? -1 : 1;
    return pa.n - pb.n;
  });
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
