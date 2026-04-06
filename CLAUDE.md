# second-opinion

Parallel plan and spec review plugin. Dispatches Claude and Codex simultaneously to review implementation plans and spec documents from independent perspectives.

## Skills

- `parallel-plan-review` — After writing a plan or spec, launch Claude + Codex reviewers in parallel. Merge findings into a unified assessment with consensus highlighting.

## Dependencies

Requires the `codex@openai-codex` plugin to be installed (for `codex-companion.mjs` access via `codex:codex-rescue` subagent).
