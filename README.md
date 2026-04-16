# codex-plan-review

계획/스펙 문서 저장 시 **OpenAI Codex가 자동으로 리뷰**하는 Claude Code 플러그인.

[superpowers](https://github.com/obra/superpowers) 워크플로우의 self-review 단계에서 Codex 리뷰 결과를 함께 참고하여 한 번에 수정할 수 있습니다.

## 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [codex 플러그인](https://github.com/openai/codex-plugin-cc) 설치 및 설정 완료
- [superpowers 플러그인](https://github.com/obra/superpowers) (선택, 이 플러그인의 워크플로우에 맞춰 설계됨)
- `python3` (hook의 상태 머신 로직에 필요. 대부분의 Linux/macOS 시스템에 기본 설치)

## 설치

```bash
/plugin marketplace add DLNL-Corp/codex-plan-review-plugin
/plugin install codex-plan-review@codex-plan-review
/reload-plugins
```

## 동작 방식

```
Write / Edit / MultiEdit로 계획/스펙 저장 (docs/superpowers/plans/*.md 또는 specs/*.md)
  │
  ▼  PostToolUse hook → 상태 머신 마커 확인 → HARD-GATE 메시지 주입
  │
Claude self-review 진행 (inline Edit 여러 번)
  │  이 동안 hook은 PENDING_REVIEW로 억제되어 중복 주입 없음
  ▼
Codex 리뷰 실행 (1회차, 별도 Bash 단계)
  │  plan-review.mjs → codex-companion → round++ → state=REVIEWED
  ▼
Codex가 이슈 보고 → Claude가 Edit으로 수정
  │  hook 재발동 → HARD-GATE (2회차 안내)
  ▼
Codex 리뷰 2회차 → 3회차 → 4회차 → 5회차 완료
  │
  ▼  hook 발동 시 SOFT-GATE로 전환
사용자에게 확인: "5회차 완료. 계속 돌릴까요?"
  │
  ├─ "계속" → touch unlock 파일 → 6, 7, 8, 9, 10회차 자동
  │
  ▼
10회차 완료 시 HARD-GATE (stop) → 자동 재발동 중단, 사용자 결정 요청
```

- **2단계 리뷰** — Claude가 먼저 리뷰하고 수정, 그 수정본을 Codex가 다시 리뷰 (라운드 자동 반복)
- **파일 경로 기반** — git diff가 아닌 특정 파일만 리뷰 (다른 uncommitted 변경사항에 영향 없음)
- **상태 머신 마커** — `/tmp/codex-plan-review-<sha256>.json`이 `state (NEW / PENDING_REVIEW / REVIEWED)`와 누적 `round`를 추적. 같은 리뷰 사이클 내의 연속 Edit는 1회로 묶이고, 리뷰 완료 후의 Edit는 다음 라운드로 자동 이어짐
- **Soft gate (기본 5회차)** — round 5 완료 후 다음 Edit이 들어오면 hook이 "Codex가 엣지케이스만 찾고 있을 수 있음, 계속할까?"를 사용자에게 묻도록 지시. 사용자가 "계속"이면 `touch /tmp/codex-plan-review-<hash>.unlocked`로 영구 통과, 이후 라운드는 자동
- **Hard gate (기본 10회차)** — 10회 라운드 완료 후엔 자동 재발동을 중단. 사용자가 명시적으로 마커를 삭제하거나 `/parallel-plan-review`를 수동 호출해야 추가 라운드 진행
- **Gate 설정 가능** — `/plan-reviewer-change soft-gate <N>` / `hard-gate <N>`으로 변경. `0` 또는 음수를 지정하면 해당 게이트가 비활성화됨. 환경변수 `CODEX_PLAN_REVIEW_SOFT_GATE` / `CODEX_PLAN_REVIEW_HARD_GATE`도 동일한 의미로 동작하며 settings.json보다 우선 적용
- **진단 로그** — `/tmp/codex-plan-review-hook.log`에 hook 발동/억제/soft-gate/hard-gate 기록을 남겨 디버깅 용이

## 리뷰 모드

재리뷰 시 이전 리뷰 컨텍스트를 자동으로 활용합니다.

| 모드 | 설명 | 이전 리뷰 필요 |
|------|------|:---:|
| `delta` (기본) | 이전 이슈 해결 여부 + 새 이슈 탐색 | Yes (없으면 full) |
| `full` | 전체 리뷰 (기존 동작) | No |
| `focused` | 이전 이슈 재검증만 | Yes (없으면 full) |

리뷰 결과는 `${TMPDIR}/codex-plan-review-cache/`에 캐시됩니다.

## 리뷰 대상

| 트리거 | 리뷰 범위 |
|--------|-----------|
| `docs/superpowers/specs/*.md` 저장 | 스펙 리뷰 |
| `docs/superpowers/plans/*.md` 저장 | 계획 + 스펙 교차 리뷰 (스펙이 있는 경우) |

### 리뷰 항목

- **스펙**: 명확성, 완전성, 테스트 가능성, 내부 일관성
- **교차 검증**: 모든 스펙 요구사항이 계획 태스크에 매핑되는지 확인
- **계획**: 실행 가능성, 파일 경로, 타입 일관성, TDD 구조
- **실현 가능성**: 아키텍처 우려사항, 위험한 가정

## 명령어

### `/parallel-plan-review`

계획/스펙 파일에 대해 수동으로 Codex 리뷰를 요청합니다. 자동 hook이 트리거되지 않았거나, 재리뷰가 필요할 때 사용합니다.

```bash
/parallel-plan-review docs/superpowers/plans/my-plan.md                    # 계획 리뷰 (대응 스펙 자동 탐색)
/parallel-plan-review docs/superpowers/plans/my-plan.md my-spec.md         # 계획 + 스펙 교차 리뷰
/parallel-plan-review docs/superpowers/specs/my-spec.md                    # 스펙 리뷰
/parallel-plan-review                                                       # 최근 수정된 파일 자동 탐색
/parallel-plan-review docs/superpowers/specs/my-spec.md --mode full        # 모드 오버라이드
/parallel-plan-review /path/to/other-proj/docs/superpowers/plans/foo.md    # 다른 프로젝트 리뷰
/parallel-plan-review --cwd /path/to/other-proj docs/superpowers/plans/foo.md  # --cwd로 workspace 지정
```

### `/plan-reviewer-change`

모델, 리뷰 모드, soft/hard gate를 변경합니다.

```bash
/plan-reviewer-change                       # 현재 설정 확인
/plan-reviewer-change model spark           # 모델 변경
/plan-reviewer-change model default         # 모델 기본값 복원
/plan-reviewer-change mode delta            # 리뷰 모드 변경 (full, delta, focused)
/plan-reviewer-change soft-gate 3           # Soft gate를 3회차로 변경
/plan-reviewer-change soft-gate 0           # Soft gate 비활성화 (0 또는 음수)
/plan-reviewer-change soft-gate default     # 기본값(5) 복원
/plan-reviewer-change hard-gate 20          # Hard gate를 20회차로 변경
/plan-reviewer-change hard-gate 0           # Hard gate 비활성화 (무제한 자동 반복)
/plan-reviewer-change hard-gate default     # 기본값(10) 복원
```

환경변수로도 일회성 오버라이드 가능:

```bash
CODEX_PLAN_REVIEW_SOFT_GATE=0 CODEX_PLAN_REVIEW_HARD_GATE=0 claude
```

## 프로젝트 구조

```
codex-plan-review-plugin/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   ├── hooks.json                 # PostToolUse hook 설정
│   ├── plan-review-trigger.sh     # python3 wrapper (hook entrypoint)
│   └── plan-review-trigger.py     # 상태 머신 + soft/hard gate 로직
├── scripts/
│   ├── plan-review.mjs         # 프롬프트 생성 → codex-companion 위임
│   ├── review-cache.mjs        # 리뷰 결과 캐시 관리
│   └── config.mjs              # 모델/모드 설정 스크립트
├── tests/
│   ├── review-cache.test.mjs   # review-cache 단위 테스트
│   ├── config.test.mjs         # config 단위 테스트
│   └── plan-review-args.test.mjs # 인자 파싱/프롬프트 테스트
├── commands/
│   ├── parallel-plan-review.md # /parallel-plan-review 수동 리뷰 명령어
│   └── plan-reviewer-change.md # /plan-reviewer-change 모델 변경 명령어
├── skills/
│   └── parallel-plan-review/
│       └── SKILL.md            # Claude용 스킬 지시사항
├── CLAUDE.md
└── README.md
```

## 라이선스

MIT
