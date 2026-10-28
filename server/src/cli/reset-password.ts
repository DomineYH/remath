// `npm run admin:reset-password` (H-32, PRD 9절): 관리자 비밀번호를 되찾는 유일한 길. 컨테이너 안에서 `docker exec -it`로 실행.
// 새 비밀번호는 TTY 프롬프트로만 받는다(인수·환경변수·파이프 금지). 환경에서는 DB 접속 정보만 읽는다.
import { hostname } from 'node:os';
import argon2 from 'argon2';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { createDb, must } from '../db.ts';
import { judge, readHidden } from './prompt.ts';

function fail(msg: string): never {
  console.error(`admin:reset-password: ${msg}`);
  process.exit(1);
}

if (process.argv.length > 2) fail('takes no arguments; the new password is read only from the terminal prompt');
if (!process.stdin.isTTY) fail('stdin is not a terminal. Run it interactively, e.g. docker exec -it <container> npm run admin:reset-password');
const env = z.object({ SUPABASE_URL: z.url(), SUPABASE_SERVICE_KEY: z.string().min(1) }).safeParse(process.env);
if (!env.success) fail('invalid environment:\n' + z.prettifyError(env.error));

const db = createDb(env.data.SUPABASE_URL, env.data.SUPABASE_SERVICE_KEY);
const admin = must(await db.from('users').select('id').eq('role', 'admin').maybeSingle()) as { id: string } | null;
if (!admin) fail('there is no admin user; run the seed first');

let lines: string[];
try { lines = await readHidden(process.stdin, process.stdout, ['New admin password: ', 'Repeat new admin password: ']); }
catch { fail('aborted, nothing changed'); }
const v = judge(lines[0]!, lines[1]!);
if (!v.ok) fail(v.reason === 'mismatch' ? 'the two passwords differ, nothing changed'
  : 'the password needs 8+ characters, letters and digits, and no spaces; nothing changed');

// 무조건 재설정(expected null) + 관리자 로그인 전부 종료(keep null)를 한 트랜잭션으로(0002). 감사는 그 뒤 별도 best-effort(G-27).
const ok = must(await db.rpc('change_password', {
  p_user_id: admin.id, p_expected_hash: null, p_new_hash: await argon2.hash(v.password), p_keep_token_hash: null,
}));
if (ok !== true) fail('the admin row was not updated, nothing changed');
await audit(db, console, { actor_id: null, action: 'admin.password_reset', target: admin.id, meta: { host: hostname() } });
console.log('admin password reset; every admin login has ended');
