# Vercel 검증 프로토타입 결과 (#74, 2026-10-31)

## 요약

버리는 브랜치 `proto/vercel`(코드 커밋 f1291ea·fba0f29, main 병합 없음)에서 Fastify 앱을 Vercel Preview에 올렸다. 조건은 Hobby, 함수 리전 dub1, dev DB, `MOCK_LLM=1`이다. **V3는 그대로 된다.** 함수 하나가 `/api/*`를 받고 `client/dist`는 정적 CDN으로 낸다. (a)~(h)는 모두 PASS다. 다만 (d)는 조건이 붙는다. `supportsCancellation`만 켜면 끊긴 턴을 기록하지 않지만 턴 해제를 하지 못한다. 턴 promise를 `waitUntil`에 넘기는 대안을 붙이자 F-24가 그대로 지켜졌다. Preview는 Vercel Authentication 뒤에 있어서 모든 요청은 `vercel curl`로 운영자 Mac(한국)에서 보냈다.

## 항목별 결과 (a)~(h)

| # | 결과 | 근거 |
|---|---|---|
| (a) 로그인 쿠키 | PASS | 관리자·예비교사 로그인 모두 200. `Set-Cookie`는 `remath_admin`(Max-Age 43200)과 `remath_teacher`(Max-Age 604800)이고, 둘 다 `HttpOnly; Secure; SameSite=Lax; Path=/`이다. 받은 쿠키로 `/api/auth/me`·`/api/admin/auth/me` 200. 대상은 `*.vercel.app` preview 호스트다. |
| (b) argon2 | PASS | 로그인 검증(위)이 된다. `/api/_proto/info`에서 hash는 245~640 ms, verify는 256~297 ms였다(Hobby 고정 CPU). 로컬 Mac은 약 30 ms다. 로그인 한 번이 한국에서 약 0.9 s 걸린다. |
| (c) 턴 SSE | PASS | 목 지연을 어절당 300 ms로 두면 이벤트가 300 ms 간격으로 하나씩 도착했다(17개). 순서는 `classification` → `student`의 누적 `final:false` 여러 번 → `final:true` → `done`이고, 버퍼링은 없었다. **첫 이벤트까지** 지연 0인 턴의 curl TTFB는 0.63 s, 같은 경로 `/healthz` TTFB는 0.33 s다(한국↔dub1 왕복). 그래서 서버 쪽 몫은 약 0.3 s다. |
| (d) 끊김 | PASS(조건부) | 아래 표. `waitUntil`을 쓰는 조합만 F-24(미기록 + 해제)를 지킨다. |
| (e) `?raw` | PASS | 빌드가 rolldown raw 플러그인으로 템플릿 6개(ko/en × master·analysis·mentor)를 번들에 문자열로 넣는다. 함수 안 `loadConfig`·`checkTemplates`가 통과했다. |
| (f) providers.json | PASS | `?raw`로 번들에 넣고 `loadConfig`가 파싱한다. 함수에서 providers `openai, anthropic, gemini`를 확인했다. |
| (g) SQLite + Blob | PASS | 함수 안에서 실제 `backup()`이 `/tmp/remath-backup/remath-20261031.sqlite`(232 KB, 642 ms)를 만들었다. better-sqlite3로 다시 열어 users 행 수를 확인했다. Blob private `put` 954 ms, `list` 329 ms(1개), `del` 404 ms 뒤 `list`는 0개였다. |
| (h) 리전·지연 | PASS | 함수 `VERCEL_REGION=dub1`, Node v24.22.2. Supabase(eu-west-1) Data API 왕복은 첫 요청 82 ms, 이후 21~35 ms였다. 인스턴스 init(`buildApp`+ready)은 약 130 ms다. 런타임 로그의 `region: icn1`은 요청이 들어온 엣지이고 함수 리전이 아니다. |

(d) 끊김: 1.5 s에 curl을 끊었다. 이 시점은 claim 뒤, 학생 발화가 오기 전이다. 바로 다음 턴을 보내 해제 여부를 봤다.

| 설정 | `reply.raw` close | 끊긴 턴 기록 | 턴 해제 | 판정 |
|---|---|---|---|---|
| `supportsCancellation` 끔 | 오지 않음. 함수는 응답을 끝까지 썼다(close는 4.9 s에 `writableFinished=true`로 옴) | **기록됨** | 됨 | F-24 FAIL |
| 켬 | 1.4 s에 옴(`req aborted`·`res close` wf=false·`req.signal` abort 모두) | 안 됨 | **안 됨**. 인스턴스가 바로 끝나 `withTurn` finally의 `release_turn`이 돌지 않았다. 다음 턴은 409 `turn_in_progress`, claim은 `TURN_TIMEOUT_MS`(120 s)까지 남는다 | 부분 FAIL |
| 켬 + `waitUntil(턴 promise)` | 1.4 s에 옴 | 안 됨 | 됨. close 뒤 226 ms에 턴이 정리됐고, 다음 턴은 200으로 흘렀다. 그 뒤에야 인스턴스가 끝났다 | **PASS** |

끊긴 요청에는 "Premature close"·"invalid payload type" 500 로그가 한 줄 남는다. 이미 닫힌 응답에 Fastify 오류 처리기가 쓰려 해서 생기는 소음이고, 동작에는 영향이 없다.

## 고른 방식 (V3·V5·V7·V9)

- **V3: Build Output API v3를 빌드 스크립트가 직접 만든다.** 프레임워크는 없음(`framework: null`)이다. 빌드 명령이 `.vercel/output`을 쓰면 Vercel은 그대로 쓴다.
  - `static/` = `client/dist`
  - `functions/api/index.func/` = 서버 번들 `index.mjs` + `node_modules/{argon2,@phc/format,node-gyp-build,better-sqlite3}` 사본 + `.vc-config.json`
  - `config.json` 경로: `filesystem` → `^/(api(/.*)?|healthz)$`는 함수로, 나머지는 `/index.html`(SPA 폴백)
  - `api/` 0-config(@vercel/node)나 Fastify 프리셋은 쓰지 않는다. `.ts` 확장자 import, 워크스페이스 TS 패키지, `?raw`를 다룰 수 없고, 빌드 순서도 우리가 정할 수 없다.
  - 함수 진입점은 `(req, res) => app.server.emit('request', req, res)`다. `buildApp`은 첫 요청 때 한 번 만든다.
  - argon2·better-sqlite3 패키지에는 linux-x64 prebuilds가 들어 있어 사본만으로 돈다. 원격 빌드는 Vercel에서 `npm ci` 뒤 약 47 s 걸렸다.
- **V5: 소스는 `*.md?raw`를 그대로 둔다. 셋 다 "`?raw` = 파일 텍스트"로 읽는다.**
  - Vercel 번들: rolldown raw 플러그인(`resolveId`·`load` 10줄, `raw-hooks.ts`와 같은 뜻)
  - 클라이언트·vitest: Vite가 기본으로 처리
  - 로컬 dev·CLI: 지금의 `--import ./src/raw-hooks.ts`
  - e2e는 지금처럼 dev 서버로 해도 되고, 같은 번들을 로컬 `http.createServer(handler)`로 띄워도 된다(로컬에서 확인함).
  - Vercel 진입점은 `loadConfig(env, read)`의 `read`를 디스크 대신 번들 맵으로 준다. providers.json은 `?raw`, 템플릿은 `@remath/prompts`의 `TEMPLATES`다. 그래서 `loadConfig`는 바뀌지 않는다.
  - 생성 모듈 방식은 필요 없었다.
- **V7: `supportsCancellation: true`를 유지하되, 턴 핸들러가 `withTurn(...)` promise를 `@vercel/functions`의 `waitUntil`에 넘겨야 한다.** 그렇지 않으면 끊긴 턴의 claim이 120 s 남는다. `maxDuration: 300`은 Hobby에서 받아들여졌다.
- **V9: 그대로 된다.** 백업은 `/tmp` 아래 `backup()`, better-sqlite3, `@vercel/blob`(^2.8.2) `put(access:'private')`·`list`·`del`이다. Cron 자체는 Hobby에서 production 배포에서만 돌아 Preview로는 확인하지 못했다(#78).

## T3·T4가 쓸 설정

`vercel.json`(초안, #76): BOA를 쓰면 함수·경로·리전·크론은 `vercel.json`이 아니라 빌드 스크립트가 쓰는 `.vc-config.json`·`config.json`에 둔다.

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "npm ci",
  "buildCommand": "npm run build:vercel",
  "git": { "deploymentEnabled": { "main": false } }
}
```

빌드 명령: 루트 `package.json`에 `"build:vercel": "node scripts/build-vercel.mjs"`를 둔다(프로토타입 `scripts/build-vercel.mjs` 기준). 스크립트가 쓰는 함수 설정은 다음과 같다.

```json
{ "runtime": "nodejs24.x", "handler": "index.mjs", "launcherType": "Nodejs", "shouldAddHelpers": false,
  "supportsResponseStreaming": true, "maxDuration": 300, "regions": ["dub1"], "supportsCancellation": true }
```

`config.json`에는 `{ "version": 3, "routes": [...위 3개...], "crons": [{ "path": "/api/cron/backup", "schedule": "0 3 * * *" }] }`를 둔다. 크론은 BOA `config.json`의 `crons` 필드다(#78).

- **#76(T3)**
  - 진입점 `server/src/vercel.ts`(번들 맵으로 `loadConfig`, `releaseTurns` 없음)
  - 턴 경로의 `waitUntil`
  - `.gitignore`·`.vercelignore`에 `.vercel`과 `.env*`
  - 끊긴 요청의 500 로그 소음 정리(선택)
  - `git.deploymentEnabled`는 push가 필요해 이 티켓에서 확인하지 못했다(#76에서 확인).
- **#77(T4)**: `/tmp` + `backup()` + Blob private은 그대로 된다. 보관 개수 정리는 `list({prefix})` → 오래된 것부터 `del(url)`로 한다.
- **#78(T5)**: 아래 shaping 보정을 반영한다. production 배포는 CLI `vercel deploy --prod`이고, Ignored Build Step은 막지 않는다.
- **#79(T6)**
  - 부하 도구가 Preview에 닿으려면 프로젝트의 Protection Bypass for Automation 비밀이 필요하다. `vercel curl`이 이미 하나 만들어 두었다(아래).
  - `supportsCancellation`이 끊김마다 인스턴스를 끝내므로, 그다음 요청은 새 인스턴스(init 약 130 ms)를 탄다.

## shaping 보정

`docs/stage3-vercel-shaping.md`와 #73 코멘트에서 사실과 다른 것은 다음과 같다.

1. **Ignored Build Step은 CLI 배포에 적용되지 않는다.**
   - #73 코멘트는 "모든 production 빌드(CLI 포함)가 막혀 있다"고 했다. 실제로는 `vercel deploy`가 production으로 빌드·READY 됐다.
   - 빌드 로그는 `vercel build` → `npm ci` → 빌드 명령 순으로 돌았고, 건너뛰기 줄은 없었다.
   - Git 연동 배포에는 적용된다. PR #80·#81 병합으로 생긴 main의 Git production 빌드 2건은 Canceled였다(조정자 확인).
   - #76은 이것을 `git.deploymentEnabled`로 바꾼다.
2. **프로젝트의 첫 배포는 항상 Production이다.**
   - `--prod` 없는 `vercel deploy`도 첫 배포면 production에 할당되고 production 주소에 붙는다.
   - 배포가 0건일 때 `--environment preview`를 주면 CLI가 거절한다.
   - 그래서 지금 production에는 정적 자리표시 페이지(아래)가 올라 있다. #78의 첫 실서버 배포가 이것을 바꾼다.
3. **빌드는 iad1(워싱턴)에서 돈다.** 함수 리전(dub1)과 다르다. 빌드 중 네트워크 작업(마이그레이션 등)은 빌드에 넣지 않는다.
4. **CLI 배포는 HEAD 커밋 작성자를 본다(Hobby).**
   - 로컬 git 작성자 `…@…MacBookPro.local`로 만든 커밋에서 배포하자 "commit author doesn't have permission"으로 **Blocked**됐다.
   - git 메타데이터가 없는 `git archive HEAD` 사본에서 배포하면 된다.
   - #76·#78·`deploy.sh`는 작성자 이메일을 Vercel·GitHub 계정과 맞추거나 사본에서 배포한다. Git PR Preview는 이 제한을 받지 않았다. 같은 시기 PR #80·#81의 Git 연동 Preview는 Ready였다(조정자 확인).
5. **`vercel curl`은 Protection Bypass for Automation 비밀을 프로젝트에 자동으로 만든다.**
   - 2026-10-31 08:21 UTC에 1개가 만들어졌다. 이것은 프로젝트 설정 변경이다.
   - 이 작업 중 그 값이 세션 출력에 한 번 보였다. **교체하거나 지워야 한다**(#79가 쓸 거면 교체).
6. **Hobby 한도는 shaping과 같았다.** `maxDuration: 300`, `regions: ["dub1"]`, `supportsCancellation`이 함수 설정으로 받아들여졌다.
7. **V7의 전제 보정.** `supportsCancellation`만으로는 F-24의 "턴 해제"가 되지 않는다. `waitUntil`이 필요하다(위 (d)).

## 배포 기록 · 정리

프로토타입이 낸 배포는 6건이다(상한 15). 프로젝트 목록에는 이 밖에 Git 연동 배포 4건(PR #80·#81 Preview, main production Canceled 2건)이 더 있다.

| # | 대상 | 내용 | 상태 |
|---|---|---|---|
| 1 | Production(**사고**) | `--prod` 없이 낸 첫 배포가 production으로 갔다 | 2~3분 공개(`/` 200, `/api` 500: production env에 Supabase가 없음). 데이터 노출·DB 접촉 없음. 바로 `vercel remove`로 지웠다 |
| 2 | Production(발주자 승인) | 정적 자리표시 `index.html`("ReMath — 준비 중 / Coming soon") 하나. 함수 없음 | 남김. `/api/*`·`/healthz` 404 확인 |
| 3 | Preview | 작업 트리에서 배포 | 커밋 작성자 때문에 Blocked |
| 4 | Preview | cancel 켬 | 남김 |
| 5 | Preview | cancel 끔 | 남김 |
| 6 | Preview | cancel 켬 + `waitUntil` | 남김 |

정리:

- dev DB의 임시 예비교사 `proto74t`와 그룹 `proto74 group`을 지웠다. 그 세션·발화는 cascade로 함께 지워졌다. 확인 결과 남은 것은 0이고, 관리자 세션은 로그아웃했다.
- 테스트 Blob `proto-74/…`는 지웠다(뒤의 `list` 0).
- 같은 시간에 #75의 `test:http`가 dev DB를 되풀이해 초기화했다. 그래서 세션 시험은 그 실행이 60 s 쉬는 틈에 돌렸다. 초기화에 휩쓸린 앞선 임시 행은 그 초기화가 지웠다.
- 마이그레이션은 하지 않았다. production env와 다른 프로젝트 설정도 바꾸지 않았다. 예외는 위 5번 bypass 비밀이고, `vercel curl`이 자동으로 만들었다.
