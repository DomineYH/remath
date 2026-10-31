# 3단계 보정 · 실서버 Vercel 이전 shaping — 확정 결정 (2026-10-31)

#61 코멘트(2026-10-29, 발주자)의 결정 "실서버는 로컬 개발이 끝난 뒤 **Vercel**로"를 스펙으로 만든 문서다. 2026-10-31에 발주자가 결정 6개를 추천안대로 확정했다(V1·V3·V8·V9·V10·V11). 나머지는 코디네이터 추천안이고, 검증 티켓(T1) 결과로 바뀔 수 있다. 이 문서는 `docs/stage3-shaping.md`의 Q13·Q26·Q29와 G4 런북 전제(Linux 호스트·Docker·Caddy)를 대체한다. 그 밖의 3단계 결정은 그대로다.

## 사실(코드 확인, main 00e0431)

- `server/src/index.ts`는 기동 때마다 `releaseTurns(db)`를 부른다. 끝나지 않은 세션의 진행 중 턴 표시를 **모두** 푼다. 서버리스는 인스턴스가 자주 새로 뜨므로, 다른 인스턴스가 처리 중인 턴의 claim까지 풀어 버린다.
- 그런데 `claim_turn`(0003)은 이미 `turn_started_at < now() − TURN_TIMEOUT_MS`인 고아 턴을 다시 잡는다. `record_turn`·`release_turn`도 토큰 울타리다(0003·0005). 그래서 기동 시 일괄 해제는 고아 정리를 앞당길 뿐이고, 정확성에는 필요 없다.
- 로그인 지연(`server/src/auth.ts` `createLimiter`): 프로세스 메모리 `Map`이다. 주석에 "단일 프로세스(C3) 전제. 다중 프로세스가 되면 공유 저장소로"라고 적혀 있다. Fluid Compute는 인스턴스를 여러 개 띄우므로, 인스턴스마다 따로 센다.
- 백업(`server/src/backup.ts`): Data API로 읽어 `better-sqlite3` 파일 하나에 쓴다. `BACKUP_DIR`에 `remath-YYYYMMDD.sqlite`를 `BACKUP_KEEP`개까지 보관한다. 일정은 `index.ts`의 `scheduleBackups`가 프로세스 안 타이머로 돈다. Vercel에서는 파일과 타이머가 모두 남지 않는다.
- `@remath/prompts`는 Vite식 `*.md?raw`를 import한다. 서버는 `node --import ./src/raw-hooks.ts`(Node `registerHooks`)로 이를 읽는다. Vercel 함수 빌드에는 이 훅이 없다.
- `loadConfig`는 `shared/providers.json`을 런타임에 `readFileSync`로 읽는다. `app.ts`는 `client/dist`를 `@fastify/static`으로 낸다.
- 턴 SSE: `POST /api/sessions/:id/turns`가 `Readable`을 `reply.send`로 흘린다. 끊김은 `reply.raw`의 `close`로 감지한다(끊기면 abort → 발화 미기록·턴 해제, F-24). 턴 전체 상한은 `TURN_TIMEOUT_MS` 120초다.
- 네이티브 모듈: `argon2`, `better-sqlite3`.
- 배포: `scripts/deploy.sh`의 1~4단계(Supabase 프로젝트 생성·마이그레이션(psql)·시드·스모크)는 운영자 머신에서 돈다. 5~6단계(env 교체·컨테이너·백업)와 `restore.sh`, `deploy/compose.yaml`, `Dockerfile`, CI `image` 잡, README 실서버 절(Caddy), `docs/g4-runbook.md`는 Docker/Caddy 전제다.
- Supabase: 조직의 활성 프로젝트는 dev(`ezzufgvulfwygojibujv`)와 스테이징 B(`oxmywsofwblvmaegtzkw`) 2개다. 스테이징 A(`ppbjcmvjnmwdyhuxncfq`)는 INACTIVE다. 리전은 모두 `eu-west-1`(아일랜드)이다.
- Vercel(2026-10 기준, Vercel 문서/플러그인 지식): Fluid Compute가 기본이다. Node 함수 최대 실행 시간은 Hobby 300초, Pro 800초다. Node 런타임에서 SSE 스트리밍은 설정 없이 된다. Cron은 `vercel.json` `crons`에 두고 `CRON_SECRET` Bearer로 확인한다(Hobby는 하루 1회). 클라이언트 끊김 시 함수를 중단하려면 경로별 `supportsCancellation`이 필요하다. Hobby는 비상업용만, 리전 1개, CPU/메모리 고정이다. 함수 요청·응답 본문은 4.5MB 상한이고, 스트리밍 응답은 이 상한을 받지 않는다.

## 결정

### 플랫폼 · 계정 (발주자 확정)
- **V1** Vercel **Hobby**(무료)로 시작한다. 비상업 연구·교육용 전제다. 300초·리전 1개·Cron 하루 1회·짧은 로그 보관을 받아들인다. 한도에 걸리면 Pro로 올린다(코드 변경 없음).
- **V8** Supabase: **스테이징 B 일시정지 + 스테이징 A 삭제**로 활성 자리를 만들고, 실서버 프로젝트는 같은 조직에 `deploy.sh --new`로 만든다(Q13·Q29 변경). 스테이징 역할은 Vercel Preview + dev DB(V10)가 맡는다. B는 복원 가능하게 남긴다.
- **V11** 주소는 우선 `*.vercel.app`(HTTPS 자동)이다. G4도 이 주소로 한다. 직접 도메인은 나중에 대시보드에서 붙인다(코드 변경 없음). `COOKIE_SECURE`는 기본값(true)이다.

### 서버 형태 (발주자 확정: 추천안, T1로 검증 후 고정)
- **V3** Fastify 앱 하나를 **Vercel Node 함수 하나**(`/api/*`)로 올린다. `client/dist`는 Vercel 정적 CDN으로 낸다(SPA 폴백 rewrite). 컨테이너 이미지(`Dockerfile.vercel`)는 T1이 실패할 때만 쓰는 대안이고, 그때는 발주자가 다시 확인한다.
- **V4** 리전은 Supabase 옆인 `dub1`(더블린)으로 고정한다.
- **V5** `*.md?raw`는 빌드 단계에서 문자열로 넣는다. 서버 번들 빌드에 raw 로더를 쓰거나 템플릿을 생성 모듈로 만드는 방식 중 T1이 고른다. 로컬 개발·테스트·Vercel이 같은 방식으로 템플릿을 읽어야 한다. `shared/providers.json`은 번들에 포함하거나 import한다.
- **V6** 기동 시 `releaseTurns`는 **없앤다**. 고아 턴은 `claim_turn`의 시간 초과 재획득(0003)에 맡긴다. 그래서 프로세스가 죽은 턴의 세션은 최대 `TURN_TIMEOUT_MS`(120초) 동안 `turn_in_progress`다. 지금도 다른 인스턴스·끊김 상황에서는 같은 동작이다. `releaseTurns` 함수와 테스트는 쓰는 곳이 없어지면 지운다.
- **V7** 턴 경로는 `supportsCancellation`을 켜서 끊김 의미(F-24: 끊기면 미기록·해제)를 유지한다. T1에서 Fastify `reply.raw` `close`가 Vercel에서 오는지 확인한다. 오지 않으면 T1이 대안을 보고한다. `maxDuration`은 300(Hobby 상한)으로 두고, `TURN_TIMEOUT_MS` 120초는 유지한다.

### 상태 공유
- **V12** 로그인 지연을 **DB로 옮긴다**. 규칙(C3)은 그대로다: (실, 소문자 닉네임)별 5회째 실패부터 60초 잠금, 실패 사이가 60초를 넘으면 처음부터, 성공하면 리셋. 마이그레이션 0006에서 테이블 + 원자적 rpc(검사·기록을 한 문장으로)를 만든다. `audit_log`를 세는 방식은 성공 리셋을 표현하기 어려워 쓰지 않는다. 인스턴스 메모리에 다른 상태는 두지 않는다.

### 백업 (발주자 확정)
- **V9** 매일 백업 = **Vercel Cron → `GET /api/cron/backup`**(`CRON_SECRET` Bearer, 라우트 표 밖의 운영 경로) → `/tmp`에 SQLite 생성 → **Vercel Blob 비공개 저장소**에 `remath-YYYYMMDD.sqlite`로 올림 → 새것부터 `BACKUP_KEEP`개만 남긴다. Cron 시각은 `BACKUP_AT`를 대신하는 `vercel.json` UTC 일정이다(Hobby는 그 시간대 안 임의 시각). 실패는 로그만 남긴다(H-30 유지).
- 복구: 운영자가 Blob에서 파일을 내려받아 기존 `restore.sh <file>`에 넘긴다. 내려받기 명령은 README에 둔다. 복구 경로의 DB 쪽 로직은 바꾸지 않는다.
- `better-sqlite3`가 Vercel 함수에서 돌지 않으면 T1이 대안(예: 순수 JS SQLite 라이브러리)을 보고한다. 백업 파일 형식은 그대로 둔다.

### 배포 · 환경 (발주자 확정)
- **V10** 실서버 배포는 **CLI만** 한다: `deploy.sh`가 1~4단계 뒤 5단계에서 Vercel Production env를 설정하고 `vercel deploy --prod`를 실행하며, 6단계에서 첫 백업을 실행한다. Git 연동은 **PR Preview만** 쓴다: main 병합이 실서버를 바꾸지 않게 production 자동 배포를 끈다. Preview env는 dev DB + `MOCK_LLM=1`이다.
- **V13** Vercel env: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_DB_URL`(필요 시), `SUPABASE_ANON_KEY`, `MOCK_LLM`, `KEY_VAULT_SECRET`, `MAX_TURNS`, `TURN_TIMEOUT_MS`, `BACKUP_KEEP`, `CRON_SECRET`, Blob 토큰(저장소 연결 시 자동). 비밀값은 Sensitive로 둔다. `PORT`·`BACKUP_DIR`·`BACKUP_AT`·`REMATH_*`(Docker)·`COOKIE_SECURE=false`는 실서버에서 쓰지 않는다.
- **V14** `deploy/compose.yaml`, Caddy README 절, CI `image` 잡, `Dockerfile`은 T1 PASS 뒤 문서 티켓에서 지운다. 배포 경로는 하나만 둔다.
- **V15** 관측: pino 로그는 Vercel 런타임 로그로 간다(Hobby 보관이 짧다). 집계 테이블은 두지 않는다(Q9 유지). README에 보관 한도를 적는다.

### 검증 / 게이트
- **V16** G4 전 확인: Preview(`MOCK_LLM=1`, dev DB)에 `npm run load -w server` 30세션 동시 턴을 돌린다(Q14와 같은 기준: 섞임 0, 429/5xx 0, SSE 오류 0). 로그 위생 점검도 다시 한다. 결과는 `docs/load-security-2026-10.md`에 덧붙인다.
- **V17** `docs/g4-runbook.md`를 Vercel 기준으로 다시 쓴다: 실서버 배포 → 키 등록 → 그룹·사용자 → 예비교사 세션 종료 → CSV → 첫 백업 Blob 확인. #62(G4 서명)는 이 런북으로 한다.
- **V18** 화면(`client/src/screens`·`components`·`i18n`) 동결은 유지한다. 라우트 표·오류 코드 변경은 없다(크론 경로는 표 밖 운영 경로).

## 티켓 분할

| # | 티켓 | 막는 것 | 라벨 |
|---|---|---|---|
| T0 | [사람] Vercel 준비: Hobby 계정·`vercel login`(운영자 머신)·프로젝트 생성과 GitHub 연결(Preview만), Blob 비공개 저장소 연결, `CRON_SECRET` 생성. Supabase B 일시정지·A 삭제 | — | ready-for-human |
| T1 | 검증 프로토타입: Fastify 앱을 Vercel Preview(dub1, dev DB, `MOCK_LLM=1`)에 올려 로그인 쿠키·argon2·SSE 턴 스트리밍·끊김 감지(`supportsCancellation`)·`?raw` 빌드 처리·`providers.json`·`better-sqlite3` + Blob 비공개 put을 실제로 확인한다. 결과 1쪽 + 방식 확정(V3·V5·V7·V9) | T0 | ready-for-agent |
| T2 | 로그인 지연 DB 이전: 마이그레이션 0006 + rpc + `auth.ts` 교체, 기존 규칙 테스트 유지 | — | ready-for-agent |
| T3 | Vercel 서버 진입점: 빌드 단계(템플릿·providers 포함), `vercel.json`(rewrites·SPA 폴백·`regions`·`maxDuration`·`supportsCancellation`·crons·Git 자동 배포 끔), `releaseTurns` 제거, 정적 CDN. 로컬 dev·테스트·e2e 유지 | T1 | ready-for-agent |
| T4 | 백업 크론: `/api/cron/backup` + Blob 업로드·보관 개수 정리(가짜 Blob 단위 테스트), `scheduleBackups` 제거, README 복구 절(Blob 내려받기 → `restore.sh`) | T1, T3 | ready-for-agent |
| T5 | 배포 경로 교체: `deploy.sh` 5·6단계와 `restore.sh` Vercel화(env 설정·`vercel deploy --prod`·첫 백업), compose/Dockerfile/CI image/Caddy 제거, README 실서버 절·`.env.example`, `docs/g4-runbook.md` 재작성 | T3, T4 | ready-for-agent |
| T6 | Preview 부하·보안 재점검(V16) + 결과 문서 보강 | T2, T3 | ready-for-agent |
| — | #62 G4 서명(새 런북) | T0, T5, T6 | ready-for-human |

#61은 T0으로 대체하고 닫는다. 키 3종(3번)은 #59에서 끝났고, 1·2·5번(Linux·Caddy)은 V1~V13으로 바뀌었다.

## 외부 공개·비가역 행위(발주자 확인 필요)

스펙 이슈·티켓 게시, 이 문서 커밋·push, Supabase A 삭제·B 일시정지(T0, 사람), Vercel 프로젝트 생성·GitHub 연결(T0, 사람), 실서버 배포(#62).
