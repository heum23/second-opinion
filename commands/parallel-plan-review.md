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
