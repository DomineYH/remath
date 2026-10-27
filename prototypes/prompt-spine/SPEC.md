# Master Template en/ko 스파인·오버레이 규격 초안 (프로토타입, 티켓 9)

실행: `node prototypes/prompt-spine/compile.mjs` — 두 판 구조 점검(PASS/FAIL) 후 가브리엘 시나리오를 ko/en으로 컴파일해 6개 프롬프트 전문을 출력한다. 의존성 없음.

근거: 목업 `SPINE`·`buildPrompt`·`langRule`, PRD 3·6·8절, ADR-0001(3분할)·ADR-0002(런타임 블록), 티켓 4·5·6·16의 결정. 티켓 5의 플레이스홀더 배치(13/4/3)를 그대로 따르고 새 플레이스홀더는 만들지 않았다.

## 1. 파일 배치 (`prompts/` 워크스페이스, 지도 C3)

```
prompts/
  master.ko.md   master.en.md    # 학생 프롬프트(스파인). ko가 기준판, en은 번역(티켓 4)
  analysis.ko.md analysis.en.md  # 분석 프롬프트(턴 분류 + 세션 요약 두 용도)
  mentor.ko.md   mentor.en.md    # 멘토 프롬프트(트리거 3종 공통)
  compile.ts                     # compileScenario · checkTemplates · 언어별 고정 문구
```

`prompts/`는 npm 워크스페이스 패키지로, 템플릿을 문자열로 번들해 **서버(턴 파이프라인·게시 시 컴파일)와 클라이언트(위자드 7단계 미리보기, 1단계 목 모드)가 같은 `compileScenario`를 import**한다(SCN-5 "서버가 같은 함수로"). 브라우저에서 import 가능해야 하므로 `fs`를 쓰지 않는다(프로토타입 `compile.mjs`만 편의상 `fs`로 읽음).

## 2. 섹션 구조 (두 판 동일)

| 템플릿 | 섹션 | 비고 |
|---|---|---|
| master | 서문(역할 1개) · A 출력 규칙 · B 시작 흐름 · C 시나리오 설정 · E 멘토 트리거와 세션 종료 · F 응답 스타일 · G 대화 언어 | **D 없음**(분류는 분석 템플릿으로 이동). 글자는 목업과 같게 유지해 ADR-0002의 "H) 이번 턴", 티켓 5의 "F절" 등 기존 참조가 그대로 맞는다. H는 서버가 호출마다 덧붙이는 런타임 블록이라 템플릿에 없다 |
| analysis | 서문 · A 분류 기준 · B 턴 분류(`[TURN]`) · C 세션 요약(`[REPORT]`) · D 언어 | 한 템플릿이 두 호출을 섬긴다. 어느 쪽인지는 **사용자 메시지 첫 줄의 마커**로 구분 |
| mentor | 서문 · A 출력 규칙 · B 트리거 세트 · C 이번 호출 · D 언어 | t1/t2/t3 셋 다 컴파일 시 고정(C11). 어떤 트리거가 발생했는지는 사용자 메시지가 알린다 |

목업에서 제거된 것(티켓 5·16): 서문 역할 2→1, A-1 "및/또는 멘토"·`CLS_TAIL`, A-2/A-3 접두 규칙(→"본문만"), A-7 멘토 행동, A-8 `CLS_RULE`, D절 전체, E절 멘토 대사(b)·트리거 2·3·`END_RULE`, F절 "멘토:" 줄. 티켓 4가 넘긴 "A-3 `Mentor:` 하드코딩"은 접두 폐지로 소멸.

## 3. 플레이스홀더 표 (17개, 템플릿별 집합이 두 판에서 동일)

출처 열은 PRD 6절 컬럼. `internal.*`은 `scenarios.internal jsonb`의 키, `tr.*`은 `scenario_translations`(해당 `lang`) 컬럼. "비어 있을 때"는 값이 빈 문자열/누락일 때 삽입되는 문구이며 **두 판 모두 목업 규칙을 따른다**: ko `(KEY 미입력)`, en `(KEY not provided)`.

| 플레이스홀더 | 템플릿 | 출처 | 가공 | 비어 있을 때 |
|---|---|---|---|---|
| `STUDENT_PREFIX` | master | `scenarios.student_prefix` | 그대로 | 미입력 표시(검수 외 — 프리셋 선택이라 비지 않음) |
| `STUDENT_NAME` | master, mentor | `tr.name` | 그대로 | 미입력 표시. 검수 c1 FAIL |
| `STUDENT_SHORT_DESC` | master | `tr.desc` | 그대로 | 미입력 표시(선택 필드) |
| `CHARACTERISTICS` | master | `tr.chars` | 그대로 | 미입력 표시(선택 필드) |
| `MATH_PROBLEM` | master | `tr.problem` | 큰따옴표로 감쌈(목업) | 미입력 표시. 검수 c1 FAIL |
| `BASELINE_SOLUTION` | master | `internal.baseline` | 그대로 | 미입력 표시. 검수 c1 FAIL |
| `DRAWING_DESCRIPTION` | master | `internal.drawing` | 그대로 | 미입력 표시(선택 필드) |
| `REASONING_PROFILE` | master | `internal.reasoning` | 그대로 | 미입력 표시. 검수 c1 FAIL |
| `NEVER_UNDERSTANDS` | master | `internal.never` | 그대로 | 미입력 표시. 검수 c4 FAIL |
| `PLATEAU_OR_GOAL` | master | `internal.goal` | 그대로 | 미입력 표시. 검수 c1 FAIL |
| `MISCONCEPTIONS_LIST` | master | `internal.misconceptions[].text` | `1) …\n2) …` 번호 목록 | 미입력 표시. 검수 c2 FAIL |
| `PROGRESSION_RULE` | master | `internal.prog` | 그대로(설명용, 집행은 H절) | 미입력 표시(선택 필드) |
| `LANG_RULE` | master, analysis, mentor | `scenarios.lang` → 언어별 고정 문구(`compile.ts` 상수) | 세 템플릿 공통 값 | 항상 있음 |
| `CLS_SECTION` | analysis | `scenarios.classification.{leverage,object}` | 목업 `clsList` 형식(이름·설명·예시) | 레버리지 0개면 **analysis 템플릿을 컴파일하지 않음**(`null`) |
| `CLS_RULE` | analysis | `classification` 분류명 | `[CLASSIFICATION]` 블록 형식 지시, object는 1개 이상일 때만 키 포함 | 위와 같음 |
| `END_RULE` | analysis | `classification.leverage` 분류명 | 세션 요약 지시(2~4문장, Object 언급 금지, 내부 설정 비공개) | 위와 같음 |
| `MENTOR_TRIGGERS` | mentor | `tr.t1`, `tr.t2`(줄 단위 프레임), `tr.t3` + `tr.name` | 트리거 1·2·3 블록. 목업의 `(a) 학생이 먼저 응답`·`hasTO` 분기는 서버 판정으로 옮겨져 제거 | 미입력 표시. 검수 c3 FAIL |

퇴역(티켓 5): `CLS_TAIL`, `MENTOR_PREFIX`. `scenarios.mentor_prefix` 컬럼은 남지만(PRD 6절, 대화 아바타용) 어떤 템플릿에도 주입되지 않는다 → 위자드 1단계 멘토 이모지 옆 `PlaceholderChip`은 뗀다(티켓 8이 가정한 (b) 확정).

## 4. `compileScenario` 규격

```ts
type Compiled = { student: string; analysis: string | null; mentor: string };
function compileScenario(scenario: ScenarioRow, translation: TranslationRow, lang: 'ko' | 'en'): Compiled;
function checkTemplates(): { name: 'master'|'analysis'|'mentor'; ok: boolean; placeholders: string[]; sections: string }[];
```

- **입력**: `scenarios` 행(`student_prefix`, `internal`, `classification`) + 그 `lang`의 `scenario_translations` 행 + 언어. 순수 함수, I/O 없음.
- **출력**: 세 문자열. `analysis`는 레버리지 분류가 0개면 `null`(ADR-0001 5항). 게시 시 `lang`판으로 컴파일해 저장하고(C11), 위자드 7단계는 같은 함수로 미리보기(학생→분석→멘토 순).
- **치환 규칙**: `{{KEY}}`를 값으로, 값이 비면 언어별 미입력 문구로 치환. 알 수 없는 키는 없다(템플릿의 키 집합이 고정이고 아래 점검이 지킨다).
- **런타임 블록**: 학생 호출마다 `student` 뒤에 ADR-0002의 `H) 이번 턴` 블록을 덧붙인다. 컴파일 결과에는 없다.
- **호출별 사용자 메시지**(어댑터 계약 티켓이 확정): 학생 = 대화 이력 + 예비교사 발화. 분석(턴) = `[TURN]\n학생: <직전 학생 대사>\n예비교사: <발화>`. 분석(종료) = `[REPORT]\n<서버 계산값>`(형태는 리포트 스키마 티켓). 멘토 = `[TRIGGER] 트리거 2 — 도움 요청` 한 줄 + 직전 3왕복.
- **두 판 구조 불일치 시 FAIL**: 템플릿 이름마다 (a) `{{KEY}}` 집합이 ko/en에서 다르거나 (b) `^[A-H]) ` 섹션 글자열이 다르면 FAIL. 이것이 **검수 자동 점검 7번째 항목 "두 판 템플릿 구조 일치"**(티켓 4의 6항)이며, 시나리오가 아닌 저장소 템플릿의 속성이라 `prompts/` 단위 테스트로도 같은 함수를 돌린다(한 쪽만 고치면 CI와 검수 모두 FAIL).

## 5. 채택한 추천안 (사용자 일괄 승인)

1. **섹션 글자 유지, D만 비움** — 번호를 다시 매기면 ADR-0002의 H절·F절 참조가 깨진다. 글자 공백은 LLM에 무해.
2. **멘토 템플릿은 t1/t2/t3 셋을 모두 담고, 발생 트리거는 사용자 메시지로 알린다** — 트리거마다 다른 시스템 프롬프트를 두면 `compiled_prompt`가 게시 시점에 고정되지 않는다(C11 위반). 티켓 16의 "입력 = 트리거 종류 + 해당 텍스트 + 직전 3왕복"을 (시스템에 셋 + 사용자 메시지에 종류)로 만족한다.
3. **분석 템플릿은 하나, `[TURN]`/`[REPORT]` 마커로 용도 구분** — 티켓 5의 4항("같은 분석 템플릿의 두 번째 용도") 그대로. 두 템플릿으로 나누면 플레이스홀더 배치(4개)가 깨진다.
4. **`LANG_RULE`은 세 템플릿 공통 값(언어별 1개)** — 목업 문구를 그대로 쓴다. 멘토·분석 템플릿에 "학생은 구어체" 줄이 섞여 들어가지만 무해하다. 템플릿별로 쪼갤 필요가 생기면 `compile.ts` 상수만 바꾸면 된다.
5. **비어 있을 때 동작은 목업 그대로(미입력 문구 삽입), 게시 차단은 검수가 맡는다** — 컴파일 함수가 필수 여부를 다시 판단하지 않는다. 미리보기(초안)에서 빈 자리가 눈에 보이는 것이 목업의 의도.
6. **멘토 이모지는 UI 전용 데이터(b)** — 접두 출력이 폐지되어 프롬프트에 넣을 자리가 없다. 칩 제거.
7. **`MATH_PROBLEM` 큰따옴표 감싸기 유지** — 목업 동작. 다른 값은 가공 없음.
8. **en판의 `LANG_RULE`·고정 문구는 영어** — 목업은 en 시나리오에도 한국어 스파인을 썼지만 이제 en 템플릿 자체가 영어이므로 주입 문구도 영어여야 일관된다.

## 6. 알려진 한계 · 다른 티켓으로

- `classification`의 설명·예시는 언어가 섞인 텍스트인데 `scenarios`(언어 공유) 컬럼이다(PRD 6절, 목업도 동일). 시나리오 언어를 바꾸면 분류 기준 문구는 그대로 남는다. 이 지도에서는 PRD대로 두고 DB 티켓에 관찰로 남긴다.
- 컴파일 결과가 3개가 되었으므로 `scenarios.compiled_prompt text` 1개 컬럼은 맞지 않는다 → DB 마이그레이션 초안에서 결정.
- `[REPORT]` 페이로드 형태와 요약 문장 수(여기서는 2~4) → 리포트 스키마 티켓이 확정하면 `END_RULE` 문구만 맞춘다.
