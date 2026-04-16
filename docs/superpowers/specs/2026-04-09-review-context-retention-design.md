# Review Context Retention Design

Codex 재리뷰 시 이전 리뷰 컨텍스트를 유지하여 delta 리뷰를 가능하게 하는 기능.

## Problem

현재 재리뷰 시 Codex가 매번 백지 상태에서 전체 문서를 처음부터 분석한다. 이전에 지적한 이슈가 수정되었는지 알 수 없고, 동일한 분석을 반복하므로 시간이 낭비되고 리뷰 흐름이 끊긴다.

## Solution Overview

리뷰 결과를 임시 디렉토리에 캐시하고, 재리뷰 시 이전 이슈 목록을 프롬프트에 포함하여 Codex가 delta 리뷰를 수행하도록 한다.

## Review Modes

| Mode | Description | Previous Review Required |
|------|-------------|:---:|
| `full` | 전체 리뷰 (현재 동작과 동일) | No |
| `delta` | 이전 이슈 해결 여부 + 새 이슈 탐색 | Yes (없으면 full fallback) |
| `focused` | 이전 이슈 재검증만, 새 이슈 탐색 없음 | Yes (없으면 full fallback) |

기본값: `delta`.

**이전 리뷰가 APPROVED (이슈 0건)인 경우**: delta/focused 모드는 검증할 이전 이슈가 없으므로 full로 자동 fallback. 이는 "이전 리뷰 없음"과 동일하게 처리된다.

## Review Cache Manager (`scripts/review-cache.mjs`)

### Storage

- 경로: `${TMPDIR}/codex-plan-review-cache/`
- 파일명: `<ISO-timestamp>-<filePath-SHA256-first8>.json` (예: `2026-04-09T143000Z-a1b2c3d4.json`). `<filePath-SHA256-first8>`은 정규화된 `filePath`의 SHA-256 앞 8자로, 동일 파일의 리뷰를 디렉토리 스캔 없이 glob으로 빠르게 필터 가능.
- 조회: `filePath` 기반으로 가장 최근 리뷰 반환

### Schema

```json
{
  "filePath": "docs/superpowers/plans/my-plan.md",
  "fileHash": "<SHA-256 of file content, or newline-joined per-file SHA-256s for multi-file reviews>",
  "timestamp": "2026-04-09T14:30:00Z",
  "reviewMode": "full",
  "parseSuccess": true,
  "verdict": "ISSUES_FOUND | APPROVED | UNKNOWN",
  "issues": [
    { "id": "ISS-1", "severity": "critical", "section": "Task 3", "description": "..." }
  ],
  "previousIssueStatuses": [],
  "rawOutput": "... full Codex output ..."
}
```

**필드 설명**:

- `reviewMode`: 이 리뷰가 어떤 모드로 실행되었는지 기록.
- `parseSuccess`: fenced JSON 파싱 **및 구조 검증** 성공 여부. `saveReview()`는 `JSON.parse()` 후 2단계 검증을 수행:
  1. **Top-level**: full 모드 — `verdict`(string, `APPROVED`|`ISSUES_FOUND`) + `issues`(array). delta 모드 — `verdict`(string) + `previous_issue_statuses`(array) + `new_issues`(array, 빈 배열 허용). focused 모드 — `verdict`(string) + `previous_issue_statuses`(array).
  2. **Item-level**: `issues[]` 항목은 `severity`+`section`+`description` 필수. `previous_issue_statuses[]` 항목은 `status` 필수 (`id`/`severity`/`section`은 매칭에 사용되나 누락 시 fuzzy fallback으로 처리).
  3. **Verdict 일관성**: `verdict: APPROVED`인데 UNRESOLVED/PARTIALLY_RESOLVED 항목이 있거나 `new_issues`가 비어있지 않으면 → `verdict`를 `ISSUES_FOUND`로 교정하여 저장.

  어느 top-level 검증이라도 실패하면 `parseSuccess: false`. `false`이면 `issues`는 빈 배열이며 `rawOutput`만 유효.
- `issues[].id`: `saveReview()`가 부여하는 안정적 ID (`ISS-1`, `ISS-2`, ...). full 모드에서는 1부터 순차 부여. delta/focused 모드에서 미해결 이전 이슈는 원래 ID를 유지하고, 신규 이슈는 `max(기존 ID 번호) + 1`부터 순차 부여하여 유일성을 보장한다. 예: 기존 `ISS-1`, `ISS-3`이 미해결이면 신규 이슈는 `ISS-4`부터 시작.

**이슈 carry-forward 규칙**:

`saveReview()`는 delta/focused 출력에서 `previous_issue_statuses`를 파싱하고, `previousReview.issues`의 각 이슈에 대해 매칭을 수행한 뒤:
1. 매칭 성공 + `RESOLVED`: `issues`에서 제외
2. 매칭 성공 + `UNRESOLVED`/`PARTIALLY_RESOLVED`: 원래 `id`, `severity`, `section`을 유지하고, Codex가 `detail`을 반환했으면 `description`을 `detail`로 갱신, 없으면 기존 `description`을 유지하여 `issues`에 포함
3. **매칭 실패 (Codex가 해당 이전 이슈에 대한 status를 반환하지 않음)**: 해당 이전 이슈를 UNRESOLVED로 간주하고 원래 정보 그대로 `issues`에 포함 — 안전한 방향으로 처리
4. 신규 이슈 (`new_issues`): 새 ID 부여 후 `issues`에 추가

이를 통해 `issues` 배열이 항상 **현재 미해결 이슈의 완전한 목록**이 되며, 다음 리뷰의 baseline으로 사용된다.

`previousIssueStatuses`는 delta/focused 리뷰에서만 채워지며, Codex JSON 출력의 `previous_issue_statuses`를 그대로 저장한다. 스키마는 Codex 출력 contract와 동일:
```json
{
  "previousIssueStatuses": [
    { "id": "ISS-1", "severity": "critical", "section": "Task 3", "status": "RESOLVED" },
    { "id": "ISS-2", "severity": "important", "section": "Spec 2.1", "status": "UNRESOLVED", "detail": "..." }
  ]
}
```

**`previousReview` 없이 delta/focused 실행된 경우**: 정상 흐름에서는 발생하지 않음 (모드 결정 로직이 full로 fallback). 방어적으로, `saveReview()`에 `previousReview`가 없으면 carry-forward를 건너뛰고, delta 모드는 `new_issues`만, focused 모드는 `previous_issue_statuses`에서 UNRESOLVED/PARTIALLY_RESOLVED 항목만 `issues`로 저장한다.

### Functions

- `saveReview(filePath, rawOutput, mode, previousReview?)` — Codex 출력에서 fenced JSON 블록 (` ```json ... ``` `)을 추출하여 `JSON.parse()`로 파싱 후 저장. 파싱 성공 시 `parseSuccess: true`, 실패 시 `parseSuccess: false`로 기록. delta/focused 모드에서는 `previousReview` (호출자가 전달)의 `issues`를 기반으로 carry-forward 규칙을 적용하여 `issues`를 통합. `previousReview`가 필요하지만 전달되지 않으면 carry-forward를 건너뛰고 파싱된 결과만 저장. 파싱 실패 시 `verdict`는 `"UNKNOWN"`으로 기록.
- `findPreviousReview(filePath)` — 캐시 디렉토리에서 정규화된 `filePath`가 일치하는 가장 최근 리뷰 반환. 없으면 `null`.
- `extractIssuesSummary(review)` — `review.issues` 배열이 비어있지 않으면 각 이슈를 아래 정확한 포맷으로 텍스트화하여 반환. `issues`가 비어있으면 (`parseSuccess` 값과 무관하게) `null` 반환 → 호출자가 full fallback으로 전환. 출력 포맷 (한 이슈당 한 줄):
  ```
  [ISS-1] (critical) Task 3: <description, first 200 chars, single line>
  [ISS-2] (important) Spec 2.1: <description, first 200 chars, single line>
  ```
  `description`은 개행을 공백으로 치환하고 200자로 truncate하여 한 줄을 보장한다. `id`, `severity`, `section`은 대괄호/소괄호로 구분되어 있으므로 Codex가 정확히 echo할 수 있다.
- `normalizePath(...paths)` — 경로 배열을 `path.resolve()` 후 알파벳 정렬, `\n` join. 단일 파일이면 그대로 resolve.

### Path Normalization

캐시 조회 시 경로를 정규화하여 동일 파일에 대한 캐시 미스를 방지한다:
- `path.resolve()`로 절대 경로화
- trailing slash 제거

### Multi-file Key

복수 파일 리뷰 (plan + spec)의 경우, 정규화된 경로를 알파벳 순으로 정렬한 뒤 `\n`으로 join하여 `filePath`로 저장. 정렬을 통해 인자 순서와 무관하게 동일 키를 보장한다.

`fileHash`도 동일한 정렬 순서로 각 파일 내용의 SHA-256을 `\n`으로 join한 문자열을 그대로 저장한다 (재해싱하지 않음). 파일 읽기 실패 시 해당 파일 자리에 `"unreadable"` 문자열을 사용하여 캐시 쓰기는 실패하지 않도록 한다 (`fileHash`는 현재 구현에서 단순 기록용이며 캐시 조회 키로 사용되지 않음).

## Prompt Structure by Mode

### Structured Output Format (all modes)

모든 모드에서 Codex 출력의 파싱 가능성을 보장하기 위해, `<structured_output_contract>`에 fenced JSON 블록 출력을 요구한다. JSON은 Node.js 내장 `JSON.parse()`로 파싱 가능하므로 외부 의존성이 불필요하다. `saveReview()`는 이 JSON을 파싱하여 `issues`와 `previousIssueStatuses`를 추출한다.

프롬프트에서는 가독성을 위해 YAML 스타일로 구조를 설명하되, 실제 출력은 fenced JSON을 요구한다:

```yaml
# full mode output
verdict: APPROVED | ISSUES_FOUND
issues:
  - severity: critical | important | suggestion
    section: "Task 3, Step 2"
    description: "..."
```

```yaml
# delta/focused mode output
verdict: APPROVED | ISSUES_FOUND
previous_issue_statuses:
  - id: "ISS-1"
    severity: critical
    section: "Task 3"
    status: RESOLVED | UNRESOLVED | PARTIALLY_RESOLVED
    detail: "..."  # UNRESOLVED/PARTIALLY_RESOLVED인 경우만
new_issues:  # delta mode only
  - severity: critical | important | suggestion
    section: "Spec 2.1"
    description: "..."
```

delta/focused 프롬프트의 `<previous_review_issues>`에 각 이슈의 `id`를 포함하여, Codex가 응답에서 동일한 `id`를 echo하도록 한다. 이를 통해 `saveReview()`가 이전 이슈와 정확히 매칭할 수 있다.

**파싱 실패 처리**: `parseSuccess: false`로 기록, `issues`를 빈 배열로, `rawOutput` 전체를 보존. 다음 리뷰에서 `extractIssuesSummary()`는 `parseSuccess`를 확인하고:
- `parseSuccess: true` + `issues` 비어있음 → APPROVED → `null` 반환 → full fallback
- `parseSuccess: false` → `null` 반환 → full fallback (비구조화 텍스트를 delta에 삽입하는 대신 깨끗하게 full 재시작)

### full mode

현재 `buildPrompt()`와 동일하되, `<structured_output_contract>`를 위의 fenced JSON 포맷으로 교체.

### delta mode

```
<task>
You are performing a DELTA REVIEW. A previous review found issues
in this document. The author has made revisions.

Your job:
1. For each previous issue, determine: RESOLVED / UNRESOLVED / PARTIALLY_RESOLVED
2. If unresolved, explain what still needs fixing
3. Scan for NEW issues introduced by the revisions
</task>

<previous_review_issues>
[extractIssuesSummary() output]
</previous_review_issues>

<structured_output_contract>
Return your findings as a fenced JSON block (```json ... ```):

{
  "verdict": "APPROVED | ISSUES_FOUND",
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
Omit "detail" for RESOLVED issues. Omit "new_issues" in focused mode.
After the JSON block, add a plain-text Summary section.
</structured_output_contract>

<grounding_rules>
Ground every finding in the actual document text.
Reference specific spec sections, task numbers, and step numbers.
Do not flag style preferences or hypothetical issues.
</grounding_rules>

--- DOCUMENTS ---
[full current document content]
```

### focused mode

delta와 동일하되:
- `<task>` step 3 제거 (새 이슈 탐색 없음)
- `<structured_output_contract>`에서 `new_issues` 필드 제거

## Configuration

### settings.json

```json
{
  "pluginConfigs": {
    "codex-plan-review@codex-plan-review": {
      "options": {
        "reviewMode": "delta"
      }
    }
  }
}
```

`model` 필드는 기존 동작을 유지: 필드 부재 또는 falsy 값 = Codex CLI 기본 모델 사용, truthy 문자열 = `--model` 인자로 전달. `reviewMode`도 동일 패턴: 필드 부재 = `"delta"` 기본값.

### config.mjs 확장

기존 모델 설정 패턴에 `getReviewMode(settings?)`, `setReviewMode(settings, mode)` 추가. `settings`는 옵셔널 파라미터 (없으면 내부에서 `readSettings()` 호출). 유효값 검증: `full`, `delta`, `focused` (shared 모듈 내부에서 검증, CLI와 별개). `config.mjs`는 `plan-review.mjs`가 `import`하는 공유 모듈로 사용된다 — 기존 `getCurrentModel()` 패턴과 동일하게 `plan-review.mjs`에서 `import { getReviewMode, getCurrentModel } from './config.mjs'`로 호출.

### CLI

```bash
# plan-review.mjs — --mode 플래그로 리뷰 모드 지정. 위치 무관 (파일 경로 앞/뒤 가능).
# plan-review.mjs는 process.argv에서 --mode와 그 값을 먼저 추출하고, 나머지를 파일 경로로 취급.
node plan-review.mjs [--mode full|delta|focused] <file1> [file2]
node plan-review.mjs <file1> [file2] [--mode full|delta|focused]
```

### /plan-reviewer-change 명령어 문법

기존 모델 변경과 모드 변경을 동일한 명령어에서 서브커맨드로 구분:
```
/plan-reviewer-change model spark          # 모델 변경
/plan-reviewer-change model default        # 모델 기본값 복원
/plan-reviewer-change mode delta           # 리뷰 모드 변경
/plan-reviewer-change mode full
/plan-reviewer-change mode focused
```

인자 없이 실행하면 현재 설정(model + reviewMode)을 표시.

### /parallel-plan-review 명령어 문법

`--mode` 플래그로 일회성 모드 오버라이드. `plan-review.mjs`의 `--mode`와 동일한 값 사용. `--mode`는 파일 경로 앞이나 뒤 어디에나 올 수 있다:

```
# 단일 파일
/parallel-plan-review docs/superpowers/specs/my-spec.md
/parallel-plan-review docs/superpowers/specs/my-spec.md --mode full
/parallel-plan-review --mode focused docs/superpowers/plans/my-plan.md

# 복수 파일 (plan + spec)
/parallel-plan-review docs/superpowers/plans/my-plan.md docs/superpowers/specs/my-spec.md
/parallel-plan-review docs/superpowers/plans/my-plan.md docs/superpowers/specs/my-spec.md --mode delta

# 인자 없음 (최근 수정 파일 자동 탐색)
/parallel-plan-review
/parallel-plan-review --mode full
```

`--mode` 없으면 settings 기본값, settings 없으면 `delta`.

## End-to-End Flow

### First Review (no previous review)

1. Write tool triggers hook → `plan-review-trigger.sh`가 `additionalContext`로 Bash 명령 주입 → Claude가 해당 Bash 명령 실행 → `plan-review.mjs` 실행
2. `findPreviousReview(filePath)` → `null`
3. 모드가 delta/focused여도 → full fallback
4. `buildPrompt("full", docs)` → Codex 실행
5. `plan-review.mjs`가 codex-companion의 stdout을 tee하여 실시간 표시와 동시에 버퍼에 캡처
6. 실행 완료 후 캡처된 출력으로 `saveReview(filePath, rawOutput, "full")`

### Re-review (previous review exists)

1. `/parallel-plan-review` 실행
2. `findPreviousReview(filePath)` → 이전 리뷰 반환
3. 모드 결정: CLI flag > settings > `"delta"` default
4. `extractIssuesSummary(previousReview)` → 이슈 요약 (또는 `null`)
5. 이슈 요약이 `null`이면 (APPROVED) → `resolvedMode`를 `"full"`로 override
6. `buildPrompt(resolvedMode, docs, issuesSummary)` → Codex 실행
7. stdout tee로 실시간 표시 + 버퍼 캡처
8. `saveReview(filePath, rawOutput, resolvedMode, previousReview)` — JSON 파싱하여 미해결 이슈 + 신규 이슈를 `issues`에 통합 저장 (step 2에서 조회한 `previousReview`를 전달)

### Subsequent Re-reviews

`findPreviousReview`는 항상 가장 최근 리뷰를 반환하므로, N번째 리뷰는 N-1번째 이슈를 기준으로 delta 수행. 리뷰 체인이 자연스럽게 형성됨.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| 이전 리뷰 없음 + delta/focused 모드 | full로 자동 fallback |
| 이전 리뷰 APPROVED (이슈 0건) + delta/focused 모드 | `extractIssuesSummary()` → `null` → full로 자동 fallback |
| 이전 리뷰 파싱 실패 (`parseSuccess: false`) + delta 모드 | `extractIssuesSummary()` → `null` → full로 자동 fallback |
| 현재 리뷰 파싱 실패 | `parseSuccess: false`, `issues: []`, `rawOutput` 보존 |
| 캐시 소실 (`/tmp` 클린업) | full로 자동 fallback, 경고 없음 |
| 복수 파일 | 정규화 + 정렬 후 join하여 단일 `filePath` 키 + 결합 `fileHash` |
| focused → delta 전환 | focused 결과의 `issues`에 미해결 이슈만 남아있으므로, delta가 이를 baseline으로 사용 + 새 이슈 탐색 추가 |
| 경로 표현 차이 (상대/절대) | `normalizePath()`로 정규화하여 캐시 히트 보장 |
| ID 매칭 실패 (Codex가 ID를 echo하지 않음) | `severity`+`section` 정확 매칭 시도. 동일 severity+section인 이전 이슈가 복수면 순서대로 1:1 매칭. 매칭되지 않은 이전 이슈는 UNRESOLVED로 보존 |

## Files to Modify

| File | Change |
|------|--------|
| `scripts/review-cache.mjs` | **New** — cache manager module |
| `scripts/plan-review.mjs` | Mode branching, cache integration, CLI flag parsing, prompt builder extension |
| `scripts/config.mjs` | `reviewMode` get/set |
| `commands/parallel-plan-review.md` | `--mode` flag docs, full grammar examples |
| `commands/plan-reviewer-change.md` | `mode` subcommand docs |
| `hooks/plan-review-trigger.sh` | 변경 없음 — 기존 `additionalContext` 주입 방식 유지. hook은 mode를 전달하지 않으며, `plan-review.mjs`가 settings에서 기본 모드를 읽음 |
| `hooks/hooks.json` | 변경 없음 |
| `README.md` | `reviewMode` 설정, `--mode` 플래그, `/plan-reviewer-change mode` 문법 반영 |
| `.claude-plugin/plugin.json` | Version bump |
