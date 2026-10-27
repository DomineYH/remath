// 0001_init.sql 자체 점검. 실행: PGLITE_DIR=<@electric-sql/pglite 를 설치한 폴더> node prototypes/db-migration/check.mjs
// 의존성을 저장소에 넣지 않으려고 PGlite(Postgres WASM)를 바깥 폴더에서 로드한다. 실 Supabase 에서는 psql 로 같은 파일을 적용하면 된다.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const { PGlite } = createRequire(join(process.env.PGLITE_DIR ?? process.cwd(), 'package.json'))('@electric-sql/pglite');
const sql = readFileSync(join(here, 'db/migrations/0001_init.sql'), 'utf8');
const db = new PGlite();
const rows = async (q, p) => (await db.query(q, p)).rows;
const fails = async (q, re) => { await assert.rejects(db.exec(q), (e) => re.test(e.message) || (console.error(e.message), false), q); };

// Supabase 가 만들어 두는 역할과 기본 GRANT 흉내
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);

await db.exec(sql);                                               // 1. 적용
await fails(sql, /already applied/);                              // 2. 재적용 거부
assert.deepEqual(await rows('select version, name from schema_migrations'), [{ version: '0001', name: 'init' }]);

// 3. 샘플 행
const [admin] = await rows(`insert into users (nickname, password_hash, role) values ('Admin', 'h', 'admin') returning id`);
const [tch] = await rows(`insert into users (nickname, password_hash) values ('teacher1', 'h') returning id`);
await fails(`insert into users (nickname, password_hash, role) values ('Admin2', 'h', 'admin')`, /users_single_admin/);
await fails(`insert into users (nickname, password_hash) values ('TEACHER1', 'h')`, /users_nickname_key/);
const [grp] = await rows(`insert into groups (name) values ('g1') returning id`);
await db.query(`insert into group_members values ($1, $2)`, [grp.id, tch.id]);
const compiled = { student: 's', analysis: null, mentor: 'm' };
const mk = async (slug, status, assign) => {
  const [s] = await rows(`insert into scenarios (slug, status, lang, compiled_prompt) values ($1, $2, 'ko', $3) returning id`,
    [slug, status, status === 'published' ? compiled : null]);
  await db.query(`insert into scenario_translations (scenario_id, lang, name, misconceptions) values ($1, 'ko', $2, '[{"kw":"왜","h":"음","c":"아"}]'), ($1, 'en', $3, '[]')`, [s.id, slug + '-ko', slug + '-en']);
  if (assign) await db.query(`insert into group_scenarios values ($1, $2)`, [grp.id, s.id]);
  return s.id;
};
const visible = await mk('a-visible', 'published', true);
await mk('b-draft', 'draft', true);
await mk('c-unassigned', 'published', false);
await fails(`insert into scenarios (slug, status) values ('bad', 'published')`, /check constraint/);  // 게시본은 compiled_prompt 필수

// 4. 예비교사 읽기 경로
const mine = await rows(`select * from teacher_scenarios($1)`, [tch.id]);
assert.equal(mine.length, 1); assert.equal(mine[0].id, visible); assert.equal(mine[0].name, 'a-visible-ko');   // 활성 lang 판
assert.ok(!('internal' in mine[0]) && !('compiled_prompt' in mine[0]) && !('misconceptions' in mine[0]), 'view leaks server-only columns');
assert.equal((await rows(`select * from teacher_scenarios($1)`, [admin.id])).length, 0);

// 5. 연습 세션·발화·updated_at
const [ses] = await rows(`insert into sessions (user_id, scenario_id, lang, progress, created_at, updated_at) values ($1, $2, 'ko', '{"mis":[0]}', now() - interval '1 minute', now() - interval '1 minute') returning id`, [tch.id, visible]);
await db.query(`insert into turns (session_id, seq, speaker, text, leverage) values ($1, 1, 'teacher', '왜?', 'Eliciting'), ($1, 2, 'student', '음', null)`, [ses.id]);
await fails(`insert into turns (session_id, seq, speaker, text) values ('${ses.id}', 2, 'mentor', 'x')`, /turns_session_id_seq_key/);
await fails(`insert into turns (session_id, seq, speaker, text, trigger) values ('${ses.id}', 3, 'mentor', 'x', 4)`, /check constraint/);
await fails(`delete from scenarios where id = '${visible}'`, /violates RESTRICT setting of foreign key/);                 // 기록 있는 시나리오 삭제 불가
await db.query(`update sessions set ended_at = now() where id = $1`, [ses.id]);
assert.ok((await rows(`select updated_at > created_at as ok from sessions`))[0].ok, 'updated_at trigger');
await db.query(`delete from users where id = $1`, [tch.id]);                                         // USR-1 cascade
assert.equal((await rows(`select count(*)::int as n from turns`))[0].n, 0);

// 6. RLS 2차 방어: anon/authenticated 는 아무것도 못 읽고, 나중에 만든 테이블도 노출되지 않는다
await db.exec(`create table later (x int)`);
for (const role of ['anon', 'authenticated']) {
  await db.exec(`set role ${role}`);
  for (const q of ['select * from scenarios', 'select * from scenarios_public', `select * from teacher_scenarios('${admin.id}')`, 'select * from ai_settings', 'select * from later']) {
    await fails(q, /permission denied/);
  }
  await db.exec(`reset role`);
}
await db.exec(`set role service_role`);
assert.equal((await rows(`select count(*)::int as n from scenarios`))[0].n, 3);                      // BYPASSRLS, 정책 0개여도 읽힘
await db.exec(`reset role`);
console.log('0001_init.sql: all checks passed');
