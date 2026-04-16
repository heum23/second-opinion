# Cross-Project cwd Support for plan-review.mjs

## 배경

`codex-plan-review` 플러그인은 Claude Code 세션이 실행된 프로젝트(이하 "호출자 프로젝트")를 Codex의 workspace root로 가정한다. 그러나 실제 사용 시나리오 중 하나는 1번 프로젝트에서 Claude를 실행한 상태로 2번 프로젝트의 코드 수정을 돕기 위해 2번 프로젝트 경로에 plan/spec 문서를 작성하는 경우이다.

현재 구현(`scripts/plan-review.mjs:358-361`)은 `spawn("node", args, { cwd: process.cwd() })`로 codex-companion을 실행한다. 또한 `main()`의 close handler(line 415-417)에서 `markReviewCompleted(file1)`을 호출하여 상태 머신 마커를 갱신하는데, 이 `file1`도 동일한 경로 기반으로 결정되어야 마커 hash가 hook과 일관된다. `process.cwd()`는 Claude 세션의 cwd(=1번 프로젝트)이므로, codex-companion의 `resolveCommandCwd` → `resolveWorkspaceRoot` 체인이 1번 프로젝트를 workspace root로 잡고 Codex sandbox를 그 경로에 고정한다. 결과적으로:

- 문서 텍스트 자체는 `readFileSync`로 읽혀 prompt에 embed되므로 Codex에 전달된다.
- 하지만 Codex의 grounding 검증(파일 경로 존재 여부, API/타입 일관성, 기존 코드 구조 확인)은 1번 프로젝트 트리에서만 수행된다.
- 결국 2번 프로젝트의 실제 코드와 괴리된 "반쪽짜리" 리뷰가 된다.

`codex-companion.mjs`는 이미 `--cwd <path>` (alias `-C`) 옵션을 지원하며, 이 값이 주어지면 `resolveCommandCwd`가 그것을 workspace root로 resolve한다. 따라서 수정 범위는 `plan-review.mjs`가 대상 프로젝트의 cwd를 결정해 spawn cwd와 codex-companion 인자에 전달하는 것으로 제한된다.

## 목표

1. 1번 프로젝트에서 Claude Code를 실행 중이라도 2번 프로젝트의 plan/spec 파일을 리뷰할 때 Codex가 2번 프로젝트를 workspace root로 인식하고 grounding 검증을 수행할 수 있어야 한다.
2. 기존 호출 방식(호출자 프로젝트 내부 파일 리뷰)과 완전한 하위 호환을 유지한다.
3. Hook 자동 트리거 경로(`plan-review-trigger.sh` → `plan-review.mjs`)도 별도 수정 없이 새 동작의 혜택을 받는다.

## 비목표

- codex-companion.mjs 수정. 이미 필요한 기능을 제공한다.
- Multi-workspace 동시 리뷰. 한 번의 호출은 하나의 workspace만 대상으로 한다.
- 호출자가 명시한 파일 경로를 복잡한 규칙으로 재해석. 규칙은 단순하고 예측 가능해야 한다.

## 설계

### 1. 사용자 인터페이스

`plan-review.mjs`에 `--cwd <path>` 플래그(alias `-C`)를 추가한다.

```bash
# 자동 감지 (일반 케이스)
node plan-review.mjs /home/user/proj2/docs/superpowers/plans/foo.md
# → 파일 절대경로의 dirname에서 git rev-parse로 proj2 git root 감지
# → Codex workspace = proj2

# 명시적 override
node plan-review.mjs --cwd /home/user/proj2 docs/superpowers/plans/foo.md
# → 파일 경로가 --cwd 기준으로 resolve → /home/user/proj2/docs/...
# → Codex workspace = /home/user/proj2

# 기존 케이스 (호환성)
node plan-review.mjs docs/superpowers/plans/foo.md
# → 호출자 cwd에서 resolve → 호출자 git root 감지 → 기존 동작과 동일
```

### 2. Resolve 로직

`plan-review.mjs`가 **자체적으로 post-promotion workspace**를 계산한다. 이렇게 해야 `plan-review`가 stderr에 출력하는 workspace 로그, spawn cwd, codex-companion의 `--cwd` 인자가 모두 같은 값으로 일관된다. codex-companion 내부의 `resolveWorkspaceRoot`가 사실상 동일한 promotion을 수행하지만, plan-review가 먼저 계산해 두면 다음 이점이 있다.

- 사용자가 stderr 로그만 보고 "어느 프로젝트가 workspace로 잡혔는지"를 결정적으로 판단할 수 있다(수동 검증 결정 신호).
- spawn cwd와 `--cwd`가 모두 git root로 일원화되어 codex-companion의 재승격이 멱등이 된다.

중복처럼 보이지만 관찰 가능성을 위한 의도적 중복이며 동작 의미는 codex-companion과 동일해야 한다.

**codex-companion의 workspace resolver 계약** (참조용, codex-companion 설치 경로 내부의 `scripts/lib/workspace.mjs`):

```js
export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);  // git rev-parse --show-toplevel
  } catch {
    return cwd;  // non-git 경로는 그대로 workspace로 사용
  }
}
```

plan-review의 `detectGitRoot` 헬퍼(3.3 참조)는 이 동작을 거울처럼 따른다.

**결정 순서**:

```
1. --cwd 주어짐?
   YES → baseDir = resolve(process.cwd(), cliCwd)
   NO  → baseDir = process.cwd()

2. resolvedFiles = files.map(f => resolve(baseDir, f))

3. cwdCandidate 결정:
   --cwd 명시됨 → cwdCandidate = baseDir
   --cwd 미명시 → cwdCandidate = dirname(resolvedFiles[0])

4. workspace = detectGitRoot(cwdCandidate) ?? cwdCandidate
   (두 모드 모두 동일한 승격 규칙을 적용한다)

5. Edge case: --cwd 명시 & 파일이 두 개 & 서로 다른 위치
   → 에러 체크 안 함. --cwd가 확정값이므로 사용자 책임으로 간주.
   → 파일이 --cwd 밖에 있어도 read 가능하면 진행.
```

**핵심 불변식**:

- `--cwd` 명시/미명시 **두 모드 모두**에서 `workspace`는 git root로 승격된 최종 값이다. 결과적으로 `plan-review`가 stderr에 찍는 `[plan-review] workspace = ...` 로그는 항상 post-promotion 값이며, codex-companion이 내부적으로 다시 `resolveWorkspaceRoot`를 호출해도 동일 입력에 대해 동일 결과가 나오는 멱등 동작이 된다.
- `--cwd`를 명시하면 사용자가 "이 cwd에서 시작하라"는 의도로 간주. git root 승격이 사용자가 지정한 하위 경로를 toplevel로 끌어올릴 수 있으나 이는 codex-companion도 동일하게 수행하므로 사용자 기대와 충돌하지 않는다. 일관성 체크는 모두 스킵.
- `--cwd` 미명시 시 fallback 경로는 **첫 번째 파일의 dirname**이며, 어떤 분기에서도 `process.cwd()`(=호출자 프로젝트)로 회귀하지 않는다. 이로써 목표 1이 모든 경우에 지켜진다.
- 자동 감지 모드에서 파일 두 개가 서로 다른 git root에 속하는 경우는 **체크하지 않는다**. 첫 번째 파일 기준 workspace가 잡히고, 두 번째 파일은 그 밖에 있어도 read만 되면 진행된다. 이는 드문 구성이며 사용자가 의도적이라면 허용할 가치가 있다(monorepo submodule 등). 동일 repo 배치가 권장되지만 강제되지는 않는다.

### 3. `plan-review.mjs` 변경 지점

**3.1 `parseArgs` 확장**

반환값 타입을 `{ mode, files }`에서 `{ mode, cwd, files }`로 확장한다. `--cwd`는 `--mode`와 동일한 파싱 스타일(값 하나 받음, 위치 자유)로 처리하고 `-C`를 alias로 지원한다.

```js
export function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = null;
  let cwd = null;
  const files = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") { /* 기존 로직 */ }
    else if (args[i] === "--cwd" || args[i] === "-C") {
      if (i + 1 >= args.length) throw new Error("--cwd requires a value");
      cwd = args[i + 1];
      i++;
    }
    else files.push(args[i]);
  }
  // ... 기존 files.length > 2 체크 ...
  return { mode, cwd, files };
}
```

**3.2 신규 `resolveWorkspace(cliCwd, files)` 함수**

> 구현 주의: 현재 `plan-review.mjs`의 path import는 `import { join, resolve } from "node:path"`뿐이다. 아래 구현에서 `dirname`이 추가로 필요하므로 `import { dirname, join, resolve } from "node:path"`로 확장한다.

```js
export function resolveWorkspace(cliCwd, files) {
  const baseDir = cliCwd ? resolve(process.cwd(), cliCwd) : process.cwd();
  const resolvedFiles = files.map((f) => resolve(baseDir, f));
  const cwdCandidate = cliCwd ? baseDir : dirname(resolvedFiles[0]);
  const workspace = detectGitRoot(cwdCandidate) ?? cwdCandidate;
  return { workspace, resolvedFiles };
}
```

이 함수의 계약은 "입력을 결정적으로 절대경로로 변환하고, 두 모드 모두에서 git root 승격을 수행한다"이다. 호출자 cwd(`process.cwd()`)는 오직 `baseDir` 계산에만 사용되며, 자동 감지 fallback으로는 **결코 반환되지 않는다**. 반환되는 `workspace`는 post-promotion 값이므로 stderr 로그, spawn cwd, codex-companion의 `--cwd` 인자가 모두 동일한 값으로 일관된다.

**3.3 신규 `detectGitRoot(dir)` 헬퍼**

codex-companion의 `resolveWorkspaceRoot` 동작을 그대로 본딴 보조 함수. 실패 시 `null`을 반환해 호출부가 명시적 fallback을 결정할 수 있게 한다.

```js
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
```

**3.4 신규 `buildSpawnArgs(codexScript, workspace, promptFile, model)` 함수**

Codex 리뷰 호출에 쓰이는 argv 배열을 구성하는 순수 함수.

```js
export function buildSpawnArgs(codexScript, workspace, promptFile, model) {
  const args = [codexScript, "task", "--cwd", workspace, "--prompt-file", promptFile];
  if (model) args.push("--model", model);
  return args;
}
```

**3.5 신규 `prepareSpawn(parsed, codexScript, promptFile, model)` 함수**

`main()`의 wiring 대부분을 단위 테스트 가능한 형태로 추출한다. 이 함수는 spawn 호출 자체는 하지 않고, "spawn에 넘길 인자 묶음"을 반환한다.

```js
export function prepareSpawn(parsed, codexScript, promptFile, model) {
  const { cwd: cliCwd, files } = parsed;
  const { workspace, resolvedFiles } = resolveWorkspace(cliCwd, files);
  const args = buildSpawnArgs(codexScript, workspace, promptFile, model);
  return { workspace, resolvedFiles, spawnArgs: args };
}
```

`main()`에서 실제 `spawn`, `readFileSync`, `saveReview` 등을 호출하는 부분이 이 객체의 값으로 구성된다. 덕분에 "cli 파싱 결과로부터 spawn에 정확히 어떤 cwd와 어떤 argv가 들어가는지"를 단위 테스트에서 결정적으로 확인할 수 있다.

**3.6 `main()` 수정**

`main()`의 호출 순서를 다음과 같이 재구성한다. `prepareSpawn`이 `codexScript`와 `promptFile`을 인자로 요구하므로 두 값이 먼저 준비되어야 하고, `resolvedFiles`가 나온 뒤에야 `existsSync`/`buildPrompt` 등을 수행할 수 있다.

```
1. parseArgs(process.argv) → parsed
2. parsed.files.length === 0 체크 → usage 에러 (files=[]이면 dirname에서 에러)
3. codex-companion.mjs 탐색 → codexScript
4. resolveWorkspace(parsed.cwd, parsed.files) → { workspace, resolvedFiles }
5. const [file1, file2] = resolvedFiles
6. existsSync(file1) 체크. file2가 존재하는 경우에만 existsSync(file2) 체크.
   (기존 main()과 동일한 패턴: file2 && !existsSync(file2) 가드)
7. getCurrentModel() → model
8. mkdtempSync → tmpDir, promptFile 경로 생성
   (file validation 후에 실행하여 file not found 시 불필요한 tmpDir 생성 방지)
9. buildSpawnArgs(codexScript, workspace, promptFile, model) → spawnArgs
10. normalizePath/findPreviousReview/resolveMode/extractIssuesSummary (resolvedFiles 기반)
11. buildPrompt(file1, file2, ...) → writeFileSync(promptFile, prompt)
12. stderr workspace 로그
13. spawn("node", spawnArgs, { cwd: workspace })
14. stream handlers, close handler (markReviewCompleted(file1) 포함)
```

> 참고: `resolveWorkspace`(step 4)와 `buildSpawnArgs`(step 9)를 분리 호출한다. `prepareSpawn`은 이 두 함수를 조합하는 편의 함수로서 export/테스트 대상으로 남기지만, `main()`에서는 file validation(step 6)과 tmpDir 생성(step 8) 사이에 끼워야 하므로 분리 호출이 필수다.

- close handler의 `markReviewCompleted(file1)`은 변경 불필요 — `file1`은 `const [file1, file2] = resolvedFiles;`에서 오므로 `path.resolve`가 적용된 절대경로다. 마커 hash 일관성: hook의 Python 코드(`hashlib.sha256(file_path.encode("utf-8"))`)와 plan-review.mjs의 `createHash("sha256").update(filePath)`는 **동일 입력 문자열에 대해** 동일 결과를 산출한다.
  - **dot segment 리스크**: `path.resolve`는 `..`이나 `.` 세그먼트를 정규화하지만, hook은 Claude Code가 넘긴 raw `file_path`를 그대로 hash한다. 만약 Claude Code가 `/proj2/../proj2/docs/foo.md` 같은 비정규화 경로를 넘긴다면 hash가 불일치할 수 있다. 그러나 Claude Code의 Write/Edit tool contract가 clean absolute path를 넘기므로 이 시나리오는 이론적이다. 실제 위험은 없으나 이 전제를 명시적으로 기록한다.

spawn 변경 요약:

```js
// Before
const args = [codexScript, "task", "--prompt-file", promptFile];
if (model) args.push("--model", model);
const child = spawn("node", args, { stdio: [...], cwd: process.cwd() });

// After (steps 4, 6, 7-9, 12-13 from the numbered flow above)
const { workspace, resolvedFiles } = resolveWorkspace(parsed.cwd, parsed.files);
const [file1, file2] = resolvedFiles;
// ... existsSync checks (step 6) ...
const model = getCurrentModel();
const tmpDir = mkdtempSync(join(tmpdir(), "codex-plan-review-"));
const promptFile = join(tmpDir, "prompt.txt");
const spawnArgs = buildSpawnArgs(codexScript, workspace, promptFile, model);
// ... cache/mode/prompt build, writeFileSync(promptFile, prompt) ...
process.stderr.write(`[plan-review] workspace = ${workspace}\n`);
const child = spawn("node", spawnArgs, { stdio: [...], cwd: workspace });
```

spawn cwd와 `--cwd` 인자를 둘 다 지정하는 이유: spawn cwd는 node 프로세스의 cwd이고, `--cwd`는 codex-companion의 `resolveCommandCwd`가 workspace root 계산에 사용하는 명시적 옵션이다. 두 값을 같게 유지해 혼동을 방지한다.

### 4. Hook (`plan-review-trigger.sh` / `plan-review-trigger.py`)

> **v6.1.0~v6.3.0 변경 반영**: Hook이 단순 마커 파일 기반에서 Python 기반 JSON 상태 머신(`NEW` → `PENDING_REVIEW` → `REVIEWED`)으로 재설계됐다. `hooks.json`의 matcher도 `Write` → `Write|Edit|MultiEdit`로 확장됐다. `.sh`는 `.py`의 thin wrapper로 변경됐다.

**변경 없음** — **단, 이 결정의 유효 범위는 아래 전제에 엄격히 종속된다.**

**외부 전제 (범위 고정)**: Claude Code의 Write/Edit/MultiEdit 툴은 `file_path` 인자를 "must be absolute, not relative"로 강제한다(툴 contract). 또한 관찰된 모든 호출에서 이 경로는 **clean canonical absolute path**이다 — `.`/`..` segment가 없고 symlink indirection이 해석된 상태다. hook의 Python 코드는 이 값을 그대로 hash하고 `plan-review.mjs`에 넘긴다. `plan-review.mjs`의 `path.resolve`도 clean absolute input에 대해 동일 출력을 산출하므로, 이 전제가 지켜지는 한 마커 hash가 hook-plan-review 간에 일관된다. Goal 3(자동 cross-project 감지)은 **이 clean canonical absolute path 전제 하에서만** 성립한다.

**contract가 위반되는 경우의 동작**: 만약 Claude Code가 contract를 어기고 상대경로를 넘긴다면, `plan-review.mjs`의 `resolveWorkspace`는 `process.cwd()`(hook이 실행되는 노드 프로세스의 cwd) 기준으로 그 상대경로를 resolve한다. 이때 결과는 **입력에 따라 완전히 달라진다**:

- `docs/foo.md` 같은 하향 상대경로는 호출자 프로젝트 하위로 resolve되어 (파일이 존재한다면) 호출자 git root로 승격될 수 있다.
- `../proj2/docs/foo.md` 같은 상향 상대경로는 호출자 프로젝트 **밖**의 임의의 repo로도 resolve될 수 있고, 그 repo로 승격될 수 있다.
- 경로가 존재하지 않으면 `existsSync` 체크에서 에러로 종료된다.

즉 contract 위반 시 최종 workspace는 input-dependent하며 결정적 보장이 없다. 이 시나리오는 본 변경의 support scope에 포함되지 않으며, contract 위반 자체가 Claude Code 차원의 이슈로 취급된다. plan-review가 추가 방어층(hook의 `realpath`, `path.isAbsolute` assertion 등)을 두지 않는 이유는 위 **대안 평가**에 기술된 대로 Goal 3 및 플러그인 전체의 일관된 contract 신뢰 전략과 충돌하기 때문이다.

**대안 평가**: hook에서 bash로 `realpath` 정규화나 git root 계산을 수행해 contract 의존성을 제거하는 방향도 가능하지만,

- Goal 3("hook이 별도 수정 없이 혜택을 받는다")과 직접 충돌한다.
- Claude Code contract를 신뢰하는 것이 플러그인 전체에서 일관된 설계 선택이다(다른 hook, 다른 플러그인도 동일한 contract에 의존).
- contract 위반은 관측된 적이 없고, 위반 시 fix는 Claude Code 쪽에서 이뤄져야 한다.

이 근거로 hook 수정은 이번 변경 범위에서 제외한다.

### 5. Cache 영향

`scripts/review-cache.mjs`의 `normalizePath`는 `path.resolve`를 사용해 절대경로로 변환 후 캐시 키를 만든다. 본 설계에서 파일 경로가 항상 절대경로로 먼저 resolve되므로 동일 파일에 대한 캐시 일관성은 자동으로 유지된다. 캐시 디렉토리는 글로벌(`tmpdir()/codex-plan-review-cache`)이며 파일 경로 hash로 항목이 분리되므로 프로젝트 간 충돌 없음. 변경 불필요.

## 테스트 계획

### 자동화 테스트

**`tests/plan-review-args.test.mjs` 확장**

- `--cwd <path>` 파싱: 반환값에 `cwd` 필드 포함
- `-C <path>` alias 동일 동작
- `--cwd` 뒤에 값 없을 때 throw
- `--cwd`와 `--mode` 혼합 순서 조합 (`--cwd x --mode full file.md`, `--mode full --cwd x file.md`)
- `--cwd` 미지정 시 `cwd === null`

**`tests/plan-review-workspace.test.mjs` (신규)**

중요 원칙: 모든 assertion에서 기대값은 **post-promotion workspace**이다. auto-detect/`--cwd` 구분 없이 `cwdCandidate`가 git repo 내부면 toplevel로 승격된 값이, git repo 밖이면 `cwdCandidate` 그대로가 `workspace`가 된다.

`resolveWorkspace` 단위 테스트:

- **auto-detect, git repo 내부**: 임시 git repo(`tmpdir + git init`) 내부의 하위 디렉토리에 있는 파일을 단일 인자로 넘겼을 때 → `workspace === repoRoot`(하위 디렉토리가 아님). `workspace !== dirname(resolvedFiles[0])`를 명시적으로 assert해 승격이 실제로 일어났음을 증명.
- **auto-detect, git repo 밖**: git이 아닌 임시 디렉토리의 파일을 단일 인자로 → `workspace === dirname(resolvedFiles[0])`. 동시에 `workspace !== process.cwd()`를 명시적으로 assert(호출자로 회귀하지 않음을 증명).
- **auto-detect, 상대경로**: 단일 상대경로 파일 + `--cwd` 미명시 → `resolvedFiles[0]`이 `process.cwd()` 기준 절대경로로 resolve되고, `workspace`가 해당 파일의 post-promotion workspace(git root 또는 dirname)인지.
- **`--cwd` 명시, git repo 하위 경로**: 임시 git repo의 하위 디렉토리를 `--cwd`로 줬을 때 → `workspace === repoRoot`(하위 디렉토리 아님). 파일 경로도 `--cwd` 기준으로 resolve됨. 이 테스트는 "`--cwd`도 승격된다"는 핵심 불변식을 직접 검증한다.
- **`--cwd` 명시, git repo 밖**: git이 아닌 절대경로를 `--cwd`로 → `workspace === "/abs/path"`(승격 실패 시 그대로). 파일도 `/abs/path` 기준 resolve.
- **`--cwd ./rel` 상대경로**: `process.cwd()`를 base로 `./rel`이 절대경로로 resolve되고 나서 `detectGitRoot(absRel) ?? absRel`이 `workspace`에 세팅되는지.
- **파일 두 개 + `--cwd` 명시**: 두 파일이 모두 `--cwd` 기준으로 resolve되고 `workspace`가 post-promotion 값과 같은지(승격 포함). repo 일관성 체크가 없음도 함께 확인.

`buildSpawnArgs` 단위 테스트:

- model 없음 → `[codexScript, "task", "--cwd", workspace, "--prompt-file", promptFile]` 순서 일치
- model 있음 → 끝에 `"--model"`, `<model>` 추가
- workspace가 spawn argv의 네 번째 요소(=`--cwd` 직후)에 들어가는지 명시적으로 assert — 회귀 방지용

`prepareSpawn` 단위 테스트 (main() wiring 검증):

- parsed = `{ mode: null, cwd: null, files: ["<absFileInsideTmpRepo>"] }` + tmpdir 기반 git repo → 반환값이 `workspace === repoRoot`, `resolvedFiles[0] === absFileInsideTmpRepo`, `spawnArgs`의 `--cwd` 값이 `repoRoot`(=post-promotion)인지 일관 확인.
- parsed + `cwd` = 임시 git repo의 하위 디렉토리 → `workspace === repoRoot`, `spawnArgs`의 `--cwd`도 `repoRoot`여야 함(승격 일관성 검증).
- parsed + `cwd` = git이 아닌 tmpdir → `workspace === tmpdir`, `spawnArgs`의 `--cwd`도 동일.
- model 전달 → `spawnArgs` 끝에 `--model <value>` 존재.

이 세 테스트로 "parseArgs 출력 → resolveWorkspace → buildSpawnArgs"의 조립 체인이 모두 커버된다. `main()`에 남는 실제 I/O(spawn/readFileSync/saveReview)는 얇아지며, 현재 테스트 프레임워크로 mock 없이 단위 검증이 가능하다.

**`main()` I/O 경계의 자동화 범위 제외 (설계 결정)**:

`main()`에 남아 있는 모든 filesystem/process 경계 호출은 **본 변경에서 자동화 테스트 범위 밖**이다. 구체적으로 다음 호출들이 포함된다.

- `existsSync(resolvedFiles[i])` — 파일 존재 확인
- `buildPrompt(...)` 내부의 `readFileSync(resolvedFiles[i], "utf8")` — 문서 내용 로드
- `normalizePath(...resolvedFiles)` / `findPreviousReview(...)` / `extractIssuesSummary(...)` — 캐시 조회
- `mkdtempSync`/`writeFileSync`/`unlinkSync` — prompt 임시 파일
- `spawn("node", spawnArgs, { cwd: workspace, ... })` — codex-companion 호출
- `process.stderr.write(`[plan-review] workspace = ${workspace}\n`)` — 관측 로그
- stream event handlers 내부의 `saveReview(...)` — 결과 저장

이 경계들이 자동화 범위에서 제외되는 근거:

- **근거 1 — 본 변경의 실질적 delta는 매우 좁다**: 이번 변경이 실제로 도입하는 *새* side effect는 단 두 가지다. (a) spawn 인자의 `--cwd`/argv와 spawn opts의 `cwd`가 `prepareSpawn` 반환값을 그대로 쓴다는 것, (b) 이 workspace 값이 stderr에 로그된다는 것. 이 두 가지는 **`prepareSpawn` 반환값의 순수 binding**이며, 모든 결정 로직은 `resolveWorkspace`/`buildSpawnArgs`/`prepareSpawn` 단위 테스트에서 직접 검증된다.
- **근거 2 — 나머지 main() I/O는 이번 변경이 새로 도입한 것이 아니다**: `existsSync`/`readFileSync`/`normalizePath`/`findPreviousReview`/`mkdtempSync`/`saveReview` 등은 본 변경 이전부터 존재했고 이전에도 자동화되지 않았다. 본 변경은 이들에 전달하는 인자를 "호출자 cwd 기준 상대경로"에서 "절대경로(=`resolvedFiles`)"로 바꿀 뿐이며, 이 치환은 `resolveWorkspace` 단위 테스트가 보장한다. 즉 이들 호출의 wiring 회귀 위험은 본 변경 이전과 동일하거나 오히려 낮아진다(입력이 항상 절대경로라 모호성이 줄어든다).
- **근거 3 — 전면 자동화의 비용/효용이 맞지 않는다**: 남은 경계를 자동화로 덮으려면 `spawn`/`stderr.write`/`fs`/`os.tmpdir` 등을 모두 의존성 주입으로 받는 `runMain(deps)` 형태의 리팩터링이 필요하다. 이는 `plan-review.mjs`의 구조 복잡도를 상당히 끌어올리고, 두 개의 외부 모듈(review-cache, codex-companion)의 경계와 얽혀 test fixture 유지 비용도 높다. 반면 실제로 발견할 수 있는 회귀는 "`prepareSpawn` 반환값을 잘못 분해했다" 수준으로 제한된다.
- **근거 4 — 수동 검증이 결정적 보완책**: 동일 경계는 **수동 검증 1-5**가 stderr 로그 비교와 실제 Codex 동작 관찰로 덮는다. 특히 수동 검증 2번은 "`--cwd` 명시 모드에서 하위 디렉토리가 git root로 승격되는지"를 결정적으로 관찰한다. 이는 자동화 테스트가 못 잡는 binding 회귀를 즉시 드러낸다.

따라서 이 범위 제외는 "테스트 공백을 묵인한다"가 아니라 "본 변경의 delta가 순수 데이터 binding이고, 결정 로직은 단위 테스트가 모두 덮으며, 나머지 I/O 회귀는 수동 검증으로 보완한다"는 명시적 scope 결정이다. 향후 `main()`에 새로운 분기 로직이 추가되는 경우(예: spawn 이전에 추가 사전 검증, 분기별 인자 조립 등) 이 결정을 재검토하고 `runMain(deps)` 형태의 의존성 주입 리팩터링을 고려한다.

**회귀**: `review-cache.test.mjs`, `config.test.mjs`는 변경 불필요. 두 파일 모두 absolute path 기반이라 영향 없음.

### 수동 검증

공통 판정 신호: **stderr에 출력되는 `[plan-review] workspace = <path>` 로그**. 이 값이 기대한 workspace와 일치하는지가 1차 결정적 기준이다. 2차 신호로 Codex가 실제로 해당 트리의 파일을 `ls`/`read`/`grep`류 명령으로 탐색하는지 출력 로그에서 확인한다(단순히 프롬프트에 박힌 파일명을 인용하는 것은 통과 기준이 아니다).

1. **Cross-project 절대경로 호출**: 1번 프로젝트에서 Claude Code를 실행한 상태로 2번 프로젝트의 plan 파일을 절대경로로 수동 호출.
   - 기대: stderr 로그가 2번 프로젝트 git root(또는 파일 dirname이 non-git이면 dirname)와 일치.
   - 보조 확인: Codex 출력에 2번 프로젝트 내부 파일 경로에 대한 탐색 명령이 기록되어야 함.
2. **`--cwd` override + 하위 디렉토리 승격 증명**: `/parallel-plan-review --cwd /home/user/proj2/docs/superpowers plans/foo.md` — 의도적으로 repo의 **하위 디렉토리**를 `--cwd`로 지정하고, 파일 경로는 **그 디렉토리 기준** 상대경로(`plans/foo.md`)로 준다. resolve 결과는 `/home/user/proj2/docs/superpowers/plans/foo.md`.
   - 기대: stderr 로그가 `/home/user/proj2`(=post-promotion repo root). 만약 `/home/user/proj2/docs/superpowers`가 그대로 찍힌다면 승격이 빠진 것이며 설계 위반으로 간주. 이 비교가 "`--cwd` 명시 모드에서도 승격이 적용된다"는 핵심 불변식의 결정적 검증이다.
   - 보조 확인: Codex 출력에 `/home/user/proj2` 기준 파일 탐색 기록이 있어야 함.
3. **Hook 경유 자동 리뷰**: 1번 프로젝트 Claude 세션에서 Write 툴로 2번 프로젝트 경로의 `docs/superpowers/plans/foo.md`를 저장 → hook 발동 → plan-review.mjs 자동 실행.
   - 기대: stderr 로그가 2번 프로젝트 경로. Codex 리뷰 결과에 2번 프로젝트 코드 기반 grounding 흔적 존재.
4. **기존 케이스 회귀**: 1번 프로젝트 내부 plan 파일을 기존 방식(`node plan-review.mjs docs/...`)으로 리뷰.
   - 기대: stderr 로그가 1번 프로젝트 git root와 동일. Codex 리뷰 결과가 기존과 동등한 품질.
5. **Non-git fallback**: `/tmp/some-dir/plan.md`처럼 git repo 밖에 있는 파일을 단일 인자로 호출.
   - 기대: stderr 로그가 `/tmp/some-dir`. Codex는 그 디렉토리를 workspace로 사용하고 git 요구 에러가 나지 않음(`task` 명령은 git repo를 요구하지 않는다).

## 문서 및 릴리즈

- `commands/parallel-plan-review.md`: `argument-hint`에 `[--cwd <path>]` 추가, Usage 섹션에 cross-project 예시 추가, Instructions 섹션에 `--cwd`/`-C` 파싱 규칙 추가. Instructions의 Bash 명령 구성(step 2)에서 파싱된 `--cwd <path>`를 `plan-review.mjs`에 그대로 전달해야 한다: `node "...plan-review.mjs" [--mode <mode>] [--cwd <path>] "<file1>" ["<file2>"]`. `--cwd`와 함께 cross-project plan을 넘길 때 대응 spec의 자동 탐색(plan 경로의 `/plans/`를 `/specs/`로 치환)은 **`plan-review.mjs`가 아닌 호출자(Claude/hook)의 책임**이다. `plan-review.mjs`는 전달된 파일 인자를 그대로 사용할 뿐 자체 spec 탐색을 하지 않는다. command instruction에서 이 동작은 기존과 동일하며 `--cwd` 추가로 변경되지 않는다.
- `README.md`: cross-project 사용 예시를 Usage 섹션 하위에 추가.
- `skills/parallel-plan-review/SKILL.md`: 변경 없음. hook 워크플로우만 설명하고 hook은 이미 자동 감지로 커버된다.
- `.claude-plugin/plugin.json`: `6.3.0` → `6.4.0` (minor bump, 기능 추가 하위 호환).
- 릴리즈: 커밋 → push → `git tag v6.4.0` → `git push origin v6.4.0`. 태그 없이는 다른 사용자의 플러그인 업데이트에서 새 버전이 감지되지 않는다 (CLAUDE.md의 Release Rules).

## 변경 파일 요약

| 파일 | 변경 유형 |
|---|---|
| `scripts/plan-review.mjs` | `parseArgs` 확장, `detectGitRoot`/`resolveWorkspace`/`buildSpawnArgs`/`prepareSpawn` 추가, `main()`의 파일 경로 처리·spawn 인자·stderr workspace 로그 |
| `tests/plan-review-args.test.mjs` | `--cwd` 파싱 케이스 추가 |
| `tests/plan-review-workspace.test.mjs` | 신규 — `resolveWorkspace`/`buildSpawnArgs` 단위 검증 |
| `commands/parallel-plan-review.md` | `--cwd` 플래그 문서화 |
| `README.md` | cross-project 사용 예시 |
| `.claude-plugin/plugin.json` | version 6.4.0 |
| `hooks/plan-review-trigger.sh` | 변경 없음 |
| `skills/parallel-plan-review/SKILL.md` | 변경 없음 |
