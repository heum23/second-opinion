#!/usr/bin/env python3
"""PostToolUse hook for the codex-plan-review plugin.

State-machine driven: a JSON marker file at
/tmp/codex-plan-review-<sha256(file_path)>.json tracks review progress so
that each plan/spec document gets one Codex review per (Write+self-review
sitting, then one per subsequent Edit round that follows a completed
review), with a soft-gate user confirmation around round 3 and a hard
cap at round 8.

- Marker schema:
    {
      "state": "NEW" | "PENDING_REVIEW" | "REVIEWED",
      "round": <int, completed Codex review rounds>,
      "soft_gate_round": <int, default 3>,
      "hard_gate_round": <int, default 8>
    }

- Unlock sentinel: /tmp/codex-plan-review-<sha256>.unlocked
    Presence indicates the user has answered "continue" at the soft gate
    so the hook should stop asking until either hard gate or user reset.

- State transitions:
    NEW / REVIEWED + next_round > soft_gate_round + unlock missing
        → emit SOFT-GATE message, state := PENDING_REVIEW
    NEW / REVIEWED otherwise
        → emit HARD-GATE fire message, state := PENDING_REVIEW
    PENDING_REVIEW
        → suppress (review already queued; avoid re-injecting context
          for every connected self-review Edit)
    round >= hard_gate_round (any state)
        → emit hard-stop message, no state change

- plan-review.mjs owns the REVIEWED transition (state := REVIEWED,
  round += 1) on successful completion.
"""

import hashlib
import json
import os
import re
import sys
import time

LOG_FILE = os.environ.get("LOG_FILE", "/tmp/codex-plan-review-hook.log")
PLUGIN_ROOT = os.environ.get("PLUGIN_ROOT") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)

# Gate defaults. A value of 0 or any negative number disables the corresponding
# gate. Resolution order: env var > ~/.claude/settings.json > default.
# Must stay in sync with DEFAULT_SOFT_GATE_ROUND / DEFAULT_HARD_GATE_ROUND in
# scripts/config.mjs.
DEFAULT_SOFT_GATE_ROUND = 5
DEFAULT_HARD_GATE_ROUND = 10
ENV_SOFT_GATE = "CODEX_PLAN_REVIEW_SOFT_GATE"
ENV_HARD_GATE = "CODEX_PLAN_REVIEW_HARD_GATE"
PLUGIN_KEY = "codex-plan-review@codex-plan-review"
SETTINGS_PATH = os.path.expanduser("~/.claude/settings.json")

MARKER_DIR = "/tmp"
PATH_PATTERN = re.compile(r"docs/superpowers/(plans|specs)/.*\.md$")


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _read_settings_options() -> dict:
    try:
        with open(SETTINGS_PATH) as f:
            data = json.load(f)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return (
        data.get("pluginConfigs", {})
        .get(PLUGIN_KEY, {})
        .get("options", {})
        or {}
    )


def _resolve_gate(env_key: str, option_key: str, default_value: int) -> int:
    env_val = os.environ.get(env_key)
    if env_val:
        parsed = _to_int(env_val)
        if parsed is not None:
            return parsed
    opts = _read_settings_options()
    if option_key in opts:
        parsed = _to_int(opts.get(option_key))
        if parsed is not None:
            return parsed
    return default_value


def resolve_soft_gate_round() -> int:
    return _resolve_gate(ENV_SOFT_GATE, "softGateRound", DEFAULT_SOFT_GATE_ROUND)


def resolve_hard_gate_round() -> int:
    return _resolve_gate(ENV_HARD_GATE, "hardGateRound", DEFAULT_HARD_GATE_ROUND)


def log(msg: str) -> None:
    try:
        with open(LOG_FILE, "a") as f:
            f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S%z')}] {msg}\n")
    except Exception:
        pass


def _hash(file_path: str) -> str:
    return hashlib.sha256(file_path.encode("utf-8")).hexdigest()


def marker_path(file_path: str) -> str:
    return f"{MARKER_DIR}/codex-plan-review-{_hash(file_path)}.json"


def unlock_path(file_path: str) -> str:
    return f"{MARKER_DIR}/codex-plan-review-{_hash(file_path)}.unlocked"


def read_marker(path: str) -> dict:
    default = {
        "state": "NEW",
        "round": 0,
        "soft_gate_round": DEFAULT_SOFT_GATE_ROUND,
        "hard_gate_round": DEFAULT_HARD_GATE_ROUND,
    }
    if not os.path.exists(path):
        return default
    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return default
        merged = {**default, **data}
        return merged
    except Exception as e:
        log(f"failed to read marker {path}: {e}; resetting")
        return default


def write_marker(path: str, data: dict) -> None:
    try:
        with open(path, "w") as f:
            json.dump(data, f)
    except Exception as e:
        log(f"failed to write marker {path}: {e}")


def build_cmd(file_path: str) -> str:
    plugin_root = PLUGIN_ROOT
    review_script = f"{plugin_root}/scripts/plan-review.mjs"
    if "/plans/" in file_path:
        plan_path = file_path
        spec_path = file_path.replace("/plans/", "/specs/")
        if os.path.exists(spec_path):
            return f'node "{review_script}" "{plan_path}" "{spec_path}"'
        return f'node "{review_script}" "{plan_path}"'
    return f'node "{review_script}" "{file_path}"'


def emit_context(ctx: str) -> None:
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": ctx,
        }
    }
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")


def normal_message(cmd: str, next_round: int, hard_gate_round: int) -> str:
    if hard_gate_round > 0:
        cap_line = f"Codex review round: {next_round} of at most {hard_gate_round} (hard cap)."
        exit_clause = (
            f"Only after a Codex review round reports no issues (or the hard gate at "
            f"round {hard_gate_round} fires) may you proceed to the user review gate, "
            f"commit, or the next skill."
        )
    else:
        cap_line = f"Codex review round: {next_round} (hard cap disabled — rounds continue until no issues remain)."
        exit_clause = (
            "Only after a Codex review round reports no issues may you proceed to the "
            "user review gate, commit, or the next skill. Note: the hard cap is "
            "currently disabled by user configuration, so there is no automatic stop."
        )
    return f"""<HARD-GATE severity="critical">
A plan/spec document was just written or edited. Before you do ANY of the following:
  - ask the user to review the spec/plan (user review gate)
  - commit the document
  - invoke writing-plans, executing-plans, or any implementation skill
  - summarize the document to the user

You MUST run the Codex cross-review as a SEPARATE Bash tool call:

  {cmd}

{cap_line}

Rules:
  1. Bash timeout MUST be 600000 (10 minutes).
  2. This is a SEPARATE Bash call — do NOT chain it inside git commit or any other command.
  3. If Codex reports issues, fix them inline FIRST, then continue. Each fix will
     auto-trigger the next review round via this same hook.
  4. {exit_clause}

This gate exists because the user installed the codex-plan-review plugin
specifically to catch spec/plan issues before human review. Skipping it
defeats the plugin's purpose. Do not skip, defer, or rationalize it away.
</HARD-GATE>"""


def soft_gate_message(
    cmd: str,
    completed_rounds: int,
    next_round: int,
    hard_gate_round: int,
    unlock_file: str,
) -> str:
    return f"""<SOFT-GATE severity="interactive">
Codex review has completed {completed_rounds} round(s) on this document. At
this point Codex is likely only finding edge-case issues. Before spending
more rounds, you MUST check with the user.

Required sequence:

  1. Ask the user EXACTLY this (translate to the conversation language if
     not English; if Korean, use the Korean version below):

     EN: "Codex review has completed {completed_rounds} rounds on this
         document, and the remaining issues look like edge cases. Do you
         want to keep running Codex reviews (up to the hard cap of
         {hard_gate_round} rounds), or stop here and move on to the user
         review gate?"

     KO: "Codex 리뷰가 {completed_rounds}회차까지 완료됐어요. 남은 이슈들이 엣지 케이스로
         보이는데, 계속 Codex 리뷰를 돌릴까요 (최대 {hard_gate_round}회차까지),
         아니면 여기서 종료하고 사용자 리뷰 게이트로 넘어갈까요?"

  2. WAIT for the user's answer. Do NOT proceed without an explicit answer.

  3. If the user says continue / 계속 / yes / keep going:
       a. Run this Bash command first: touch "{unlock_file}"
       b. THEN run the Codex review (separate Bash call):
            {cmd}
       c. All subsequent rounds up to round {hard_gate_round} will auto-proceed
          without asking the user again.

  4. If the user says stop / 종료 / no / skip:
       a. Do NOT run the Codex review.
       b. Skip directly to the user review gate: ask the user to review the
          spec/plan file and decide whether to commit.

Do NOT guess the user's intent. Do NOT pre-create the unlock file. Do NOT
run Codex before receiving an affirmative answer.
</SOFT-GATE>"""


def hard_gate_message(completed_rounds: int, hard_gate_round: int, marker_file: str) -> str:
    return f"""<HARD-GATE severity="stop">
Codex review has already run {completed_rounds} times for this document, which
has reached the hard cap of {hard_gate_round} rounds. The plugin has stopped
auto-triggering further rounds to prevent an infinite review loop.

Do NOT run `plan-review.mjs` again automatically for this document in this
session.

Required action:

  1. Tell the user that {completed_rounds} Codex review rounds have been
     consumed and the hard cap was reached.
  2. Summarize any unresolved issues from the most recent review.
  3. Ask the user how they want to proceed. Options:
       - Accept current state and move to the user review gate (recommended).
       - If they explicitly want another review cycle, they can reset the
         counter by deleting:
             {marker_file}
         and then manually invoking /codex-plan-review:parallel-plan-review.

Do not attempt to bypass this gate silently. Do not touch the unlock file.
</HARD-GATE>"""


def main() -> int:
    try:
        input_data = json.load(sys.stdin)
    except Exception as e:
        log(f"malformed stdin JSON: {e}")
        return 0

    file_path = ""
    if isinstance(input_data, dict):
        tool_input = input_data.get("tool_input") or {}
        if isinstance(tool_input, dict):
            file_path = tool_input.get("file_path") or ""

    if not file_path:
        return 0

    if not PATH_PATTERN.search(file_path):
        return 0

    marker_p = marker_path(file_path)
    unlock_p = unlock_path(file_path)
    marker = read_marker(marker_p)

    completed_rounds = int(marker.get("round", 0) or 0)
    # Gate values come from live config (env var > settings.json > default),
    # NOT from the marker file. This lets /plan-reviewer-change take effect
    # immediately without requiring a marker reset.
    soft_gate_round = resolve_soft_gate_round()
    hard_gate_round = resolve_hard_gate_round()
    state = marker.get("state", "NEW")

    # Hard gate: already consumed all rounds → emit stop message, do not touch marker.
    # Sentinel: hard_gate_round <= 0 disables the hard gate entirely.
    if hard_gate_round > 0 and completed_rounds >= hard_gate_round:
        log(f"hard-gate path={file_path} completed={completed_rounds} cap={hard_gate_round}")
        emit_context(hard_gate_message(completed_rounds, hard_gate_round, marker_p))
        return 0

    # PENDING_REVIEW: a review is already queued (or Claude is about to run it,
    # or is already running it). Suppress to avoid re-injecting context on every
    # self-review Edit or Claude-initiated fix Edit.
    if state == "PENDING_REVIEW":
        log(f"suppressed (PENDING_REVIEW) path={file_path} completed={completed_rounds}")
        return 0

    # Otherwise transition to PENDING_REVIEW and emit a message.
    next_round = completed_rounds + 1
    marker["state"] = "PENDING_REVIEW"
    marker["round"] = completed_rounds  # unchanged; plan-review.mjs bumps this on completion
    marker["soft_gate_round"] = soft_gate_round
    marker["hard_gate_round"] = hard_gate_round
    write_marker(marker_p, marker)

    cmd = build_cmd(file_path)

    # Soft gate: after soft_gate_round completed rounds, check with the user
    # (unless they have already unlocked via touch <unlock_file>).
    # Sentinel: soft_gate_round <= 0 disables the soft gate entirely.
    if (
        soft_gate_round > 0
        and completed_rounds >= soft_gate_round
        and not os.path.exists(unlock_p)
    ):
        log(
            f"soft-gate path={file_path} completed={completed_rounds} "
            f"next={next_round} unlock={unlock_p}"
        )
        emit_context(
            soft_gate_message(
                cmd, completed_rounds, next_round, hard_gate_round, unlock_p
            )
        )
        return 0

    # Normal fire.
    log(
        f"fired path={file_path} next_round={next_round} "
        f"soft={soft_gate_round} hard={hard_gate_round}"
    )
    emit_context(normal_message(cmd, next_round, hard_gate_round))
    return 0


if __name__ == "__main__":
    sys.exit(main())
