# second-opinion

계획/스펙 문서 저장 시 **OpenAI Codex가 자동으로 리뷰**하는 Claude Code 플러그인.

[superpowers](https://github.com/obra/superpowers) 워크플로우의 self-review 단계에서 Codex 리뷰 결과를 함께 참고하여 한 번에 수정할 수 있습니다.

## 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [codex 플러그인](https://github.com/openai/codex-plugin-cc) 설치 및 설정 완료
- [superpowers 플러그인](https://github.com/obra/superpowers) (선택, 이 플러그인의 워크플로우에 맞춰 설계됨)

## 설치

```bash
/plugin marketplace add heum23/second-opinion
/plugin install second-opinion@second-opinion
/reload-plugins
```

## 동작 방식

```
Write로 계획/스펙 저장 (docs/superpowers/plans/*.md 또는 specs/*.md)
  │
  ▼  PostToolUse hook → Codex 리뷰 명령어 주입 (즉시)
  │
Claude self-review 진행
  │  placeholder 스캔, 일관성, 스코프, 모호성 체크
  ▼
Self-review 이슈 수정 (Edit)
  │
  ▼
Codex 리뷰 실행 (별도 Bash 단계)
  │  plan-review.mjs → codex-companion task --prompt-file
  │  (수정된 버전을 Codex가 리뷰)
  ▼
Codex 리뷰 결과 확인 → 추가 이슈 수정
  │
  ▼
커밋
```

- **2단계 리뷰** — Claude가 먼저 리뷰하고 수정, 그 수정본을 Codex가 다시 리뷰
- **파일 경로 기반** — git diff가 아닌 특정 파일만 리뷰 (다른 uncommitted 변경사항에 영향 없음)
- **중복 방지** — 마커 파일로 같은 파일에 대한 hook 재실행 방지

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

### `/plan-reviewer-change`

Codex 리뷰에 사용할 모델을 변경합니다.

```bash
/plan-reviewer-change              # 현재 설정 확인
/plan-reviewer-change spark        # gpt-5.3-codex-spark (경량, 빠름)
/plan-reviewer-change gpt-5.4-mini # 경량 모델
/plan-reviewer-change default      # 기본값으로 복원
/plan-reviewer-change <모델명>     # 직접 지정
```

## 프로젝트 구조

```
second-opinion/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   ├── hooks.json              # PostToolUse hook 설정
│   └── plan-review-trigger.sh  # 계획/스펙 파일 감지 → Codex 실행
├── scripts/
│   ├── plan-review.mjs         # 프롬프트 생성 → codex-companion 위임
│   └── config.mjs              # 모델 설정 스크립트
├── commands/
│   └── plan-reviewer-change.md # /plan-reviewer-change 명령어
├── skills/
│   └── parallel-plan-review/
│       └── SKILL.md            # Claude용 스킬 지시사항
├── CLAUDE.md
└── README.md
```

## 라이선스

MIT
