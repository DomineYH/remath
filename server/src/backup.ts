// SQLite 백업 (H-30, O-5, PRD 7절): Data API 로 읽기만 하고 better-sqlite3 파일 하나에 쓴다.
// 실행: `npm run backup -w server`(cli/backup.ts, deploy.sh 6단계)와 서버 안 매일 타이머(index.ts).
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { must, type Db } from './db.ts';

// 서버 index.ts 와 CLI 가 각자 진입점에서 검증한다(#40 결정). 기본값은 env 가 없는 기존 배포가 그대로 뜨게.
export const BackupEnv = z.object({
  BACKUP_DIR: z.string().min(1).default('backup'),   // 상대 경로 = 작업 디렉터리(server/, 컨테이너 /app/server) 기준
  BACKUP_KEEP: z.coerce.number().int().positive().default(7),
  BACKUP_AT: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'BACKUP_AT must be HH:MM (00:00-23:59)').default('03:00'),
});

type Type = 'text' | 'json' | 'int' | 'bool';
// 열 형: 표시 없음 = TEXT(uuid·text·timestamptz), json = JSONB 를 JSON 문자열 TEXT 로, int = INTEGER, bool = INTEGER 0/1.
// auth_sessions·schema_migrations 는 넣지 않고 ai_settings.key_ciphertext 는 읽지도 만들지도 않는다(O-5, PRD 7절).
// 순서 = 복구의 FK 순서(H-31). 열 목록이 마이그레이션과 같은지는 backup.test.ts 가 PGlite 로 본다.
const SPEC = {
  users: 'id nickname password_hash role pw_updated_at created_at updated_at',
  groups: 'id name created_at updated_at',
  group_members: 'group_id user_id created_at',
  scenarios: 'id slug status lang student_prefix mentor_prefix grade internal:json classification:json compiled_prompt:json created_at updated_at',
  scenario_translations: 'id scenario_id lang name description problem chars greet aha t1 t2 t3 confused:json elicit:json misconceptions:json created_at updated_at',
  group_scenarios: 'group_id scenario_id created_at',
  sessions: 'id user_id scenario_id lang started_at ended_at goal_reached:bool counts:json progress:json report:json turn_started_at created_at updated_at turn_claim',
  turns: 'id session_id seq:int speaker text leverage object trigger:int created_at updated_at',
  ai_settings: 'role key_source provider key_masked model effort key_added_at created_at updated_at',
  audit_log: 'id actor_id action target meta:json created_at',
};
export const TABLES: Record<string, { name: string; type: Type }[]> = Object.fromEntries(Object.entries(SPEC).map(([t, cols]) =>
  [t, cols.split(' ').map(c => { const [name, type = 'text'] = c.split(':'); return { name, type: type as Type }; })]));
// 페이지 순서 = 기본 키(없으면 offset 페이지가 요청마다 다른 행을 줄 수 있다).
const KEYS: Record<string, string[]> = { group_members: ['group_id', 'user_id'], group_scenarios: ['group_id', 'scenario_id'], ai_settings: ['role'] };

// 백업 테이블 사이의 FK(0001). 부모가 자식보다 TABLES 앞에 온다. 목록이 마이그레이션과 같은지는 backup.test.ts 가 PGlite 로 본다.
// setNull = ON DELETE SET NULL(audit_log.actor_id): 행은 남기고 값만 비운다. 나머지(cascade·restrict)는 행을 버린다.
export const FKS = [
  { table: 'group_members', col: 'group_id', ref: 'groups', refCol: 'id', setNull: false },
  { table: 'group_members', col: 'user_id', ref: 'users', refCol: 'id', setNull: false },
  { table: 'scenario_translations', col: 'scenario_id', ref: 'scenarios', refCol: 'id', setNull: false },
  { table: 'group_scenarios', col: 'group_id', ref: 'groups', refCol: 'id', setNull: false },
  { table: 'group_scenarios', col: 'scenario_id', ref: 'scenarios', refCol: 'id', setNull: false },
  { table: 'sessions', col: 'user_id', ref: 'users', refCol: 'id', setNull: false },
  { table: 'sessions', col: 'scenario_id', ref: 'scenarios', refCol: 'id', setNull: false },
  { table: 'turns', col: 'session_id', ref: 'sessions', refCol: 'id', setNull: false },
  { table: 'audit_log', col: 'actor_id', ref: 'users', refCol: 'id', setNull: true },
];

const SQL_TYPE = { text: 'TEXT', json: 'TEXT', int: 'INTEGER', bool: 'INTEGER' };
const toSql = (type: Type, v: unknown) => v === null || v === undefined ? null
  : type === 'json' ? JSON.stringify(v) : type === 'bool' ? (v ? 1 : 0) : v;
const q = (id: string) => `"${id}"`;   // trigger·object·text 같은 열 이름
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * 테이블마다 Data API range 페이지(기본 1000행 = Supabase db-max-rows 기본값)로 끝까지 읽는다. 받은 행 수만큼 넘기고
 * 빈 페이지에서 멈추므로 서버 max-rows 가 페이지보다 작아도 빠지지 않는다. 임시 파일에 쓰고 fsync → rename(같은 날짜는 덮어쓰기),
 * 그다음 BACKUP_KEEP 개를 넘는 remath-<YYYYMMDD>.sqlite 를 오래된 순으로 지운다. 실패하면 임시 파일을 지우고 throw.
 * 스냅숏이 아니므로(Data API 는 트랜잭션 없음, deploy.sh 6단계는 도는 서버를 백업) 부모를 읽은 뒤 커밋된 자식 행은 부모 없이 들어온다.
 * rename 전에 파일 안에서만 그 고아를 FKS 대로 정리해 FK 순서 복구(H-31)가 멈추지 않게 한다. pruned = 테이블별 정리 행 수.
 * ponytail: 도는 중 삽입·삭제되면 페이지 경계에서 행이 빠질 수 있다(중복은 PK 로 버림). 새벽 실행이라 받아들인다;
 * 정합이 꼭 필요해지면 pg_dump(O-5 B)로 바꾼다.
 */
export async function backup(db: Db, o: { dir: string; keep: number; now?: Date; pageSize?: number }) {
  const pageSize = o.pageSize ?? 1000;
  mkdirSync(o.dir, { recursive: true });
  const file = join(o.dir, `remath-${ymd(o.now ?? new Date())}.sqlite`);
  const tmp = `${file}.${process.pid}.tmp`;   // CLI 와 서버 타이머가 겹쳐도 서로의 임시 파일을 건드리지 않는다
  const rows: Record<string, number> = {}, pruned: Record<string, number> = {};
  const sq = new Database(tmp);
  try {
    sq.pragma('journal_mode = OFF');   // 실패하면 파일째 버리므로 롤백 저널이 필요 없다
    for (const [table, cols] of Object.entries(TABLES)) {
      const keys = KEYS[table] ?? ['id'];
      sq.exec(`create table ${q(table)} (${cols.map(c => `${q(c.name)} ${SQL_TYPE[c.type]}`).join(', ')}, primary key (${keys.map(q).join(', ')}))`);
      const insert = sq.prepare(`insert or ignore into ${q(table)} values (${cols.map(() => '?').join(', ')})`);
      const insertPage = sq.transaction((page: Record<string, unknown>[]) => { for (const r of page) insert.run(cols.map(c => toSql(c.type, r[c.name]))); });
      rows[table] = 0;
      for (;;) {
        let query = db.from(table).select(cols.map(c => c.name).join(','));
        for (const k of keys) query = query.order(k);
        const page = must(await query.range(rows[table], rows[table] + pageSize - 1)) as unknown as Record<string, unknown>[];
        if (!page.length) break;
        insertPage(page);
        rows[table] += page.length;
      }
    }
    for (const f of FKS) {
      const orphan = `${q(f.col)} is not null and ${q(f.col)} not in (select ${q(f.refCol)} from ${q(f.ref)})`;
      const { changes } = sq.prepare(f.setNull ? `update ${q(f.table)} set ${q(f.col)} = null where ${orphan}` : `delete from ${q(f.table)} where ${orphan}`).run();
      if (changes) pruned[f.table] = (pruned[f.table] ?? 0) + changes;
    }
    sq.close();
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (err) {
    if (sq.open) sq.close();
    rmSync(tmp, { force: true });
    throw err;
  }
  for (const old of readdirSync(o.dir).filter(f => /^remath-\d{8}\.sqlite$/.test(f)).sort().slice(0, -o.keep)) rmSync(join(o.dir, old));
  return { file, rows, pruned };
}

/**
 * 매일 at(HH:MM, 서버 로컬 시각)에 run. 다음 실행은 이번 실행이 끝난 뒤에 잡으므로 한 번에 하나만 돈다.
 * run 의 실패는 log 로만 보내고 서버를 멈추지 않는다. now·setTimer 는 테스트가 바꾼다.
 */
export function scheduleBackups(o: {
  at: string; run: () => Promise<unknown>; log: (err: unknown) => void;
  now?: () => Date; setTimer?: (fn: () => void, ms: number) => void;
}) {
  const now = o.now ?? (() => new Date());
  const setTimer = o.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref(); });
  const [h, m] = o.at.split(':').map(Number);
  const next = () => {
    const t = now(), at = new Date(t);
    at.setHours(h, m, 0, 0);
    if (at <= t) at.setDate(at.getDate() + 1);
    setTimer(fire, at.getTime() - t.getTime());
  };
  const fire = () => { void Promise.resolve().then(o.run).catch(o.log).finally(next); };
  next();
}
