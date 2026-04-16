# codex-plan-review

Parallel plan and spec review plugin. Dispatches Claude and Codex simultaneously to review implementation plans and spec documents from independent perspectives.

## Skills

- `parallel-plan-review` — After writing a plan or spec, launch Claude + Codex reviewers in parallel. Merge findings into a unified assessment with consensus highlighting.

## Dependencies

Requires the `codex@openai-codex` plugin to be installed (for `codex-companion.mjs` access via `codex:codex-rescue` subagent).

## Release Rules

기능 추가/수정 시 반드시 아래 순서를 따를 것:

1. `.claude-plugin/plugin.json`의 `version` 올리기 (semver)
2. `git commit` + `git push`
3. `git tag vX.X.X` + `git push origin vX.X.X`

태그 없이 푸시하면 다른 사용자의 플러그인 업데이트에서 새 버전이 감지되지 않음.
