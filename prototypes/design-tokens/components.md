# 디자인 토큰 파일·컴포넌트 목록 초안 (프로토타입)

티켓: [디자인 토큰 파일·컴포넌트 목록 초안](https://github.com/DomineYH/remath/issues/8). 출처: `prd/ReMath PRD.md` 3절(11개 화면)과 `base_ui/ReMath 시뮬레이터.html`의 `#v-*` 섹션·`render*`/`open*` 함수. 용어는 `GLOSSARY.md`를 따른다.

## 1. 토큰 파일 명세

- 파일: `client/src/styles/tokens.css` (C4). 내용은 옆의 `tokens.css` — 목업 `:root` 블록 **그대로**(색 20개, 글꼴 스택 3개, 반경 2개).
- 다크 모드: `:root[data-theme="dark"]`가 명시 토글, `@media (prefers-color-scheme: dark)` + `:root:not([data-theme="light"])`가 OS 기본값 추종. 목업의 두 블록을 모두 유지한다(토글 미설정 시 OS를 따르는 동작은 목업 그대로).
- 글꼴: 목업은 Google Fonts `<link>` 하나(Fraunces 600/700, Geist 400–600, Geist Mono 400/500, Noto Sans KR). `client/index.html`에 같은 `<link>`를 둔다. 셀프 호스팅은 1단계 범위 밖.
- **간격 토큰 없음**: 목업은 간격을 리터럴 px로 쓴다. 토큰을 새로 만들지 않고 컴포넌트 CSS에 리터럴을 유지한다(PRD "그대로 옮긴다").
- 토큰 외 전역 규칙(`body` 15px/1.6, `input/textarea/select` 공통 스타일, `:focus-visible` 2px accent, `[hidden]`)은 `client/src/styles/base.css`로 한 파일 더.

## 2. 컴포넌트 목록

열: 컴포넌트(목업 클래스) · props 요지 · 쓰는 화면. "공유"는 두 화면 이상.

### 2.1 공통(shell·원자)

| 컴포넌트 (목업) | props 요지 | 쓰는 화면 |
|---|---|---|
| `AppShell` (`.top` + `.wrap`) | children. 로그인 상태를 읽어 `AccountMenu`·`AdminSubnav` 표시 | 전체 |
| `TopBar` (`.top .in`) | brand 고정, `AccountMenu`, `UiLangToggle` 슬롯 | 전체 |
| `AccountMenu` (`.acct`) | `kind: 'teacher'|'admin'`, `name`, `onChangePw?`, `onLogout` | 전체(로그인 후) |
| `SegmentedToggle` (`.seg`) | `options: {value,label}[]`, `value`, `onChange`, `label?`(앞 캡션), `ariaLabel` | **공유**: 화면 언어(`.ui-seg`), 챗봇 언어(위자드 `#lang-seg`), 로그인/계정 만들기 탭(`.auth-tabs`) |
| `AdminSubnav` (`.subnav`) | `current: 'scenarios'|'users'|'groups'|'logs'|'ai'` | /admin/* 5개 |
| `PageHead` (`.head`) | `eyebrow`, `title`, `lead?`, `actions?`(슬롯) | **공유**: 관리자 5화면, 위자드, 내 기록 |
| `Button` (`.btn`) | `variant: 'default'|'primary'|'danger'|'dangerSolid'`, `size: 'md'|'sm'`, `wide?`, `disabled` | 전체 |
| `Pill` (`.pill`) | `tone: 'neutral'|'pub'|'draft'|'lang'`, children | **공유**: 카드·표·AI 타일·그룹 |
| `StatusChip` (`.st`) | `status: 'ok'|'no'|'info'`(PASS/FAIL/INFO) | 위자드 6단계 |
| `Notice` (`.notice`) | `tone: 'ok'|'warn'|'info'`, children | **공유**: 위자드(언어·분류·게시 안내), AI 설정, 학생 선택(접근 불가) |
| `Modal` (`.modal-bg`/`.modal`) | `title`, `open`, `onClose`, children, `actions`(`.m-acts`). Esc·배경 클릭 닫기, 열기 전 포커스 복원, 첫 입력에 포커스 | 전체 모달의 바탕 |
| `ConfirmModal` | `title`, `body`, `confirmLabel`, `onConfirm`, `extraAction?`(예: "CSV 먼저 내려받기") | **공유**: 사용자 삭제, 그룹 삭제 |
| `Toast` (`.toast`) | 전역 스토어 `toast(text)`, 2.6s 후 숨김, `role=status aria-live=polite` | 전체 |
| `Field` (`.field`) | `label`, `htmlFor`, `hint?`, `placeholder?`(→ `PlaceholderChip`), children | **공유**: 위자드·모달·로그인·AI |
| `PlaceholderChip` (`.spine`) | `name`(예: `STUDENT_NAME`). 라벨 옆에 스파인 플레이스홀더 이름 표시 | 위자드 1~3단계 |
| `PasswordFields` (`pwFields()`) | `withCurrent?`(현재 비밀번호 칸), 값·오류 콜백. 내부에 `PasswordRules` | **공유**: 계정 만들기, 사용자 추가, 비밀번호 변경(관리자), 내 비밀번호 변경 |
| `PasswordRules` (`.pwrules`) | `value` → 규칙 3개 ok/no 실시간 | 위와 같음 |
| `ErrorLine` (`.err`, `role=alert`) | `message` | 모든 폼 |
| `DataTable` (`.tbl-wrap table.tbl`) | `columns: {key,label,mono?}[]`, `rows`, `renderCell`, `empty` 문구. `min-width:860px` 가로 스크롤 | **공유**: 사용자, 대화 기록, 내 기록 |
| `Card` (`.card`) | children. 시나리오·그룹·AI 카드의 바탕 | **공유** |
| `Avatar` (`.av`) | `emoji`, `size: 44|32` | **공유**: 카드, 대화 헤더, 말풍선(`.pf`) |
| `CheckList` (`.ckl`) | `items: {id,label,badge?}[]`, `checked: Set`, `onChange` | **공유**: 사용자 추가(그룹), 그룹 편집(구성원·시나리오) |

### 2.2 화면별

| 화면 (경로) | 컴포넌트 (목업) | props 요지 |
|---|---|---|
| 로그인/계정 만들기 (`/`) | `AuthCard` (`.auth-card`) | `mode: 'login'|'signup'`; `SegmentedToggle` 탭, 닉네임(maxlength 16, 이메일·전화 형태 거부), 비밀번호(login) 또는 `PasswordFields`(signup), `ErrorLine`, `Button wide`, `PrivacyNotice`(`.privacy`), `AuthLink`("관리자 로그인 →") |
| 관리자 로그인 (`/admin`) | `AdminLoginCard` (`renderAuth` admin 분기) | 아이디, 비밀번호, 구분 없는 오류 1종, `AuthLink`("← 예비교사 로그인으로"). `AuthCard`와 같은 껍데기 |
| 시나리오 목록 (`/admin/scenarios`) | `WorkflowStrip` (`.flow`) | 정적 5카드(작성→조립→검수→연습→리포트) |
| | `ScenarioCard` (`.card`) | `scenario`(이모지·이름·학년·문제·status·lang·오개념 수·분류 수·이용 그룹), `convCount`, `onEdit`, `onViewPrompt`, `onCsv`, `onTestChat`. 그룹 없으면 `AccessLine` 경고 필 |
| | `AccessLine` (`.access`) | `groups: string[]` → 이름 나열 또는 "할당된 그룹 없음 · 아무도 이용 불가" |
| 시나리오 위자드 (`/admin/scenarios/:id`) | `ScenarioWizard` | `scenarioId|'new'`. `PageHead` + actions(`SegmentedToggle` 챗봇 언어 ko/en, "예시로 채우기", "목록으로"), `LangNotice`, 2열 `.wiz` |
| | `WizardSteps` (`.steps`) | `steps: 7`, `current`, `done: Set`, `onSelect`. `aria-current="step"`, 번호 원(`.n`) |
| | `WizardNav` (`.wiz-nav`) | `onPrev`, `onSaveDraft`, `onNext`, `onPublish`(7단계에서만), `canPublish` |
| | `StepProfile` | `EmojiSelect`×2(학생·멘토, 프리셋 `db/seed/emoji_presets.json`), `PrefixPreview`(`.prefix-prev`), 이름·학년/주제·한 줄 소개·특성·첫 인사말 |
| | `StepProblem` | 수학 문제, 초기 풀이, 그림/표현 묘사 (textarea 3) |
| | `StepReasoning` | 추론 프로필, 끝까지 이해 못 하는 것, 내부 도달점, 아하 대사, `MisconceptionList`, 진전 규칙 |
| | `MisconceptionList` / `MisconceptionItem` (`.mis`) | `items: {text,kw,h,c}[]`, `onAdd`, `onRemove`, `onChange`. 항목마다 오개념 문장·교정 키워드·망설임 대사·교정 대사 |
| | `StepMentorTriggers` | t1 Taking Over 코칭, t2 질문 프레임(한 줄에 하나), t3 도달점 칭찬, 혼란 대사(한 줄에 하나) |
| | `StepClassification` | `ClassificationGroup`×2(leverage/object), "기본 분류 세트 불러오기", "모두 비우기", `ClsNotice`(분류 없음 → 분석 없음 안내) |
| | `ClassificationGroup` / `ClassificationRow` (`.clsgrid`/`.clsrow`) | `rows: {name,when,examples}[]`, `onAdd`, `onRemove`. 머리행은 ≤700px에서 숨김 |
| | `StepReview` | `AutoChecks`(`.checks`: 6행 `{label, status}` + `StatusChip`), `ManualChecks`(체크박스 4) |
| | `StepPreview` | `PubNotice`, `PromptPreview`(`pre.prompt`, 컴파일된 프롬프트 전문) |
| 사용자 (`/admin/users`) | `UsersTable` (`DataTable`) | 열: 닉네임·그룹(`Pill`)·이용 가능 시나리오·대화 수·가입일·비밀번호 변경일·동작(CSV·비밀번호·삭제) |
| | `AddUserModal` | 닉네임(+힌트), `PasswordFields`, 그룹 `CheckList`, `ErrorLine` |
| | `ChangePasswordModal` | `userName`, `PasswordFields` |
| | `DeleteUserModal` → `ConfirmModal` | `convCount` 본문, `convCount>0`이면 "CSV 먼저 내려받기" extraAction, `dangerSolid` 확인 |
| 그룹 (`/admin/groups`) | `GroupCard` (`.card` + `.gsec`/`.pills`) | `group`(이름·구성원 수), 구성원 `Pill[]`, 할당 시나리오 `Pill lang[]`(없으면 "이용 불가" draft 필), `onEdit`, `onDelete` |
| | `GroupEditModal` | `group?`(없으면 새 그룹), 이름, 구성원 `CheckList`, 시나리오 `CheckList`(초안은 draft 배지) |
| | `DeleteGroupModal` → `ConfirmModal` | 본문만 |
| 대화 기록 (`/admin/logs`) | `LogFilters` (`.filters`) | `users`, `scenarios`, `value`, `onChange`, 우측 "CSV 내려받기 (n건)"(0건이면 disabled) |
| | `SessionsTable` (`DataTable`) | 열: 시작·닉네임·시나리오·언어·발화 수·도달 여부(`Pill pub`)·보기. 최신순 |
| | `TranscriptModal` (`.tx`) | `session`(닉네임·시나리오·시작~종료), `turns: {seq, speaker, text, leverage?, object?}[]`. 발화마다 화자 + `[레버리지 · 대상]` 태그. `report?` 슬롯(내 기록에서 `SessionReport` 주입) |
| AI 설정 (`/admin/ai`) | `AiSummaryTiles` (`.ai-sum`) | 챗봇 3종 × `AiTile`(역할·모델 한 줄·상태 `Pill`) |
| | `AiBotCard` (`.card.ai-card`) | `role: 'analysis'|'student'|'mentor'`, `config`. 키 출처 select → `KeyBox`(등록됨: 공급자 필·마스킹·등록일·변경/제거) 또는 `KeyInput`(`.keyrow` + `KeyDetect` `.kdet` 즉시 공급자 표시) → `ModelSelect`(+ 직접 입력) → `EffortRadios`(`.effs`, `role=radiogroup`) |
| 학생 선택 (`/practice`) | `PracticeBanner` (`.band`) | `nickname`(인사), "내 기록" 링크 |
| | `ScenarioPickCard` (`.pick button`) | `scenario`(`scenarios_public` 열: 이모지·이름·학년·소개·lang·분류 유무), `via: string[]`(그룹 태그), `onStart` |
| | `NoAccessNotice` → `Notice warn` | `reason: 'noGroup'|'noScenario'` 문구 구분 |
| 대화 (`/practice/:scenarioId`) | `ChatScreen` (`.chat-grid`) | `session`, `isAdminTest`. 2열(대화 + `InternalStatePanel`), ≤900px 1열 |
| | `ChatHeader` (`.chat-h`) | `Avatar`, 이름·소개, `ClsToggle`(분류 기준 있을 때만), "세션 종료", "다른 학생" |
| | `ProblemBox` (`.problem`) | `problem` |
| | `MessageLog` (`.log`) | `items: (Message|SystemLine|SessionReport)[]`, 새 항목에 자동 스크롤 |
| | `Message` (`.msg`) | `speaker: 'teacher'|'student'|'mentor'`, `name`, `emoji`, `text`, `classification?`(→ `ClassificationBlock` `.cls`, 토글로 표시) |
| | `SystemLine` (`.sys`) | `text`(세션 시작·종료 안내) |
| | `SessionReport` (`.report`) | `rows: {name, desc, count, items: string[]}[]`, `total`. `LeverageBar` 재사용, Taking Over는 orange. **도달점·오개념 목록 없음** |
| | `QuickChips` (`.chips`) | `chips: string[]`(챗봇 언어별 5개, "도움 요청"·"END SESSION" 포함), `onPick` |
| | `Composer` (`.compose`) | `value`, `onSend`, `disabled`(종료 후·턴 진행 중 C8), `placeholder` |
| | `InternalStatePanel` (`.rail`) — **관리자 대화 테스트 전용** | `SecretNotice`, `LeverageBars`(`.bar` 행 + 발화 수), `MisconceptionTrack`(`.mitem` + `.dot` 0/2·1/2·2/2, 도달 시 ✓), 내부 도달점, 마지막 멘토 트리거, `ConnectedModels`(`.ai-mini-row` 3행). 데이터 계약은 [관리자 대화 테스트 내부 상태 패널 데이터 계약](https://github.com/DomineYH/remath/issues/15) |
| 내 기록 (`/practice/history`) — **목업 없음** | `HistoryScreen` | `PageHead` + `SessionsTable`(본인 행만, 열: 시작·시나리오·발화 수·도달 여부·보기) + `TranscriptModal`(`report` 슬롯에 `SessionReport`). 새 컴포넌트 없이 조합 |

목업에만 있고 제품에서 빼는 것: `.demo-tag`("클라이언트 데모 · 목데이터"), `.demo-cred`(데모 계정 안내), "데모 초기화" 버튼(`openReset`), `.as-user`(관리자가 사용자 신분으로 보기). 1단계 목 모드(C6)에서도 두지 않는다.

## 3. 라우트 표

| 경로 (PRD 3절) | 화면 컴포넌트 | 접근 |
|---|---|---|
| `/` | `AuthCard` | 비로그인. 예비교사 로그인 상태면 `/practice`로 |
| `/admin` | `AdminLoginCard` | 비로그인. 관리자 로그인 상태면 `/admin/scenarios`로 |
| `/admin/scenarios` | `AdminSubnav` + `WorkflowStrip` + `ScenarioCard[]` | 관리자 |
| `/admin/scenarios/:id` (`new` 포함) | `ScenarioWizard` | 관리자 |
| `/admin/users` | `AdminSubnav` + `UsersTable` (+ 모달 3) | 관리자 |
| `/admin/groups` | `AdminSubnav` + `GroupCard[]` (+ 모달 2) | 관리자 |
| `/admin/logs` | `AdminSubnav` + `LogFilters` + `SessionsTable` + `TranscriptModal` | 관리자 |
| `/admin/ai` | `AdminSubnav` + `AiSummaryTiles` + `AiBotCard`×3 | 관리자 |
| `/practice` | `PracticeBanner` + `ScenarioPickCard[]` \| `NoAccessNotice` | 예비교사 |
| `/practice/:scenarioId` | `ChatScreen` (`isAdminTest=false`) | 예비교사. 진행 중 연습 세션이 있으면 `GET /api/sessions/current`로 복구(C15) |
| `/practice/history` | `HistoryScreen` | 예비교사 |
| 관리자 "대화 테스트" | `ChatScreen` (`isAdminTest=true`, `InternalStatePanel` 표시) | 관리자. 경로는 `/admin/scenarios/:id/test`(PRD 3절에 없음, 추천) |

두 로그인은 분리(C9·C10)되므로 `/admin/*`은 관리자 로그인만, `/practice/*`는 예비교사 로그인만 통과시킨다. 목업의 `#admin` 해시 라우팅은 쓰지 않는다.

## 4. 400px 폭에서 깨질 후보

목업 CSS의 브레이크포인트: 1000(AI 그리드) · 900(flow 2열, 대화 1열) · 860(위자드 1열) · 700(분류 행) · 640(brand sub 숨김) · 600(row2) · 480(flow 1열). 400px에서 실제로 좁아지는 곳만 적는다. 위험 높은 순.

1. **대화 헤더 `.chat-h`**: 아바타·이름·`[CLASSIFICATION] 블록 표시` 토글·"세션 종료"·"다른 학생"이 `flex-wrap`으로 3줄이 되고, `.chat{max-height:calc(100vh - 140px)}`에서 상단 바도 2줄로 커져 **대화 로그 영역이 손바닥만 해진다.** 후보: 토글 라벨을 아이콘화하거나 도구 3개를 ⋯ 메뉴로.
2. **내부 상태 패널 `.rail`**: ≤900px에서 대화 **아래**로 내려가 관리자 대화 테스트에서 패널이 화면 밖. 후보: 접이식 드로어 또는 헤더 토글. 예비교사 화면에는 패널이 없어 영향 없음.
3. **상단 바 `.top .in`**: brand + `AccountMenu`(이름 + 비밀번호 변경 + 로그아웃) + 화면 언어 토글이 2줄로 감기면서 sticky 높이가 변해 `.steps{top:84px}`·대화 높이 계산이 어긋난다. 후보: 버튼을 아이콘 전용으로, 또는 `AccountMenu`를 드롭다운.
4. **표 `table.tbl{min-width:860px}`**(사용자 7열·대화 기록 7열·내 기록): 가로 스크롤은 되지만 동작 열(CSV·비밀번호·삭제)이 두 화면 밖. 후보: 400px에서 행을 카드로 바꾸거나 동작 열을 첫 열 옆에 고정.
5. **위자드 단계 내비 `.steps`**: ≤860px에서 가로 스크롤(`white-space:nowrap`, 7개). 스크롤 가능하다는 표시가 없다. 후보: 번호 원만 보이고 현재 단계 이름만 펼침.
6. **위자드 `.head-tools`**: 챗봇 언어 세그먼트(캡션 포함) + "예시로 채우기 (서연)" + "목록으로"가 3줄. 후보: 세그먼트 캡션 숨김, 예시 버튼 `sm`.
7. **워크플로 띠 `.flow`**: ≤480px 1열이 되어 카드 5개가 "시나리오 관리" 머리말을 두 화면 아래로 밀어낸다. 후보: 모바일에서 가로 스크롤 또는 숨김.
8. **분류 행 `.clsrow`**: ≤700px 1열이 되고 머리행(`분류명·어떤 경우·예시 발문`)이 숨겨져 세 textarea가 라벨 없이 쌓인다. 후보: 각 칸에 placeholder 또는 모바일 전용 라벨.
9. **AI 설정 `.keybox .mono`**: 마스킹 키에 `overflow-wrap`이 없어 카드 밖으로 넘칠 수 있다. 후보: `overflow-wrap:anywhere` 한 줄.
10. **인디고 배너 `.band`**: `padding:36px clamp(20px,4vw,44px)`와 h2 `clamp(28px,4vw,38px)`는 괜찮지만 `.hello`·"내 기록" 링크를 더하면 배너가 화면의 절반. 후보: 모바일 패딩 24px.

문제 없음(확인): `.cards{minmax(310px)}`·`.pick{minmax(260px)}`(400−32=368px), `.modal{width:min(580px,100%)}`, `.row2`·`.ai-grid` 1열 전환, `.msg{max-width:86%}`, `.compose`, `.chips` 5개 wrap, `pre.prompt{pre-wrap}`.

축약 **규칙**(무엇을 숨기고 무엇을 남기는가)은 이 티켓이 정하지 않는다 → 지도 "Not yet specified"의 400px 항목을 grilling 티켓으로 올린다.
