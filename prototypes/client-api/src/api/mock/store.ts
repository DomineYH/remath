// 목 저장소 — 메모리 한 객체 + localStorage 한 키. 서버 테이블과 같은 이름·같은 snake_case 열(티켓 11)이라 2단계에서 HTTP 로 바꿔도 화면은 모른다.
// 키는 목업(`remath.scen.v3` 등)과 다르게 새로 시작한다(모양이 다르고 섞이면 깨진다). 초기화 = 이 키 삭제.
import type { z } from 'zod';
import type { SessionState } from '../../../../llm-adapter/src/engine.ts';
import * as S from '../../../../api-contract/src/schemas.ts';
import { scenario as gabriel, translations as gabrielTr } from '../../../../llm-adapter/sample.mjs';

export const STORAGE_KEY = 'remath.mock.v1';

export interface UserRow { id: string; nickname: string; password: string; role: 'teacher' | 'admin'; created_at: string; pw_updated_at: string } // 목이라 평문. 시드 비밀번호는 목업과 같다
export interface GroupRow { id: string; name: string; member_ids: string[]; scenario_ids: string[] }
export type ScenarioRow = z.infer<typeof S.ScenarioInput> & { id: string; slug: string; status: 'draft' | 'published'; compiled_prompt: z.infer<typeof S.Compiled> | null; created_at: string; updated_at: string };
export interface SessionRow { id: string; user_id: string; scenario_id: string; lang: 'ko' | 'en'; started_at: string; ended_at: string | null; progress: SessionState; turn_started_at: string | null; report: z.infer<typeof S.SessionReport> | null }
export type TurnRow = z.infer<typeof S.Turn> & { session_id: string };
export interface Db {
  users: UserRow[]; groups: GroupRow[]; scenarios: ScenarioRow[]; sessions: SessionRow[]; turns: TurnRow[];
  login: { teacher: string | null; admin: string | null };   // 쿠키 2개의 흉내: 실별 로그인 사용자 id
  ai: z.infer<typeof S.AiSettings>;
}

export interface Storage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export const memoryStorage = (): Storage => { const m = new Map<string, string>(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: k => void m.delete(k) }; };

export class Store {
  db: Db; storage: Storage;
  constructor(storage: Storage, seed: () => Db) {
    this.storage = storage;
    const raw = storage.getItem(STORAGE_KEY);
    this.db = raw ? JSON.parse(raw) : seed();
    if (!raw) this.save();
  }
  save() { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.db)); }
}

// ---- 시드: 목업 SEED_USERS·SEED_GROUPS·SEED(시나리오) 를 새 모양으로. 저장소에서는 db/seed/samples/*.json 과 같은 파일을 읽는다(C12).
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const SEED_IDS = { admin: uid(1), u: (i: number) => uid(100 + i), g: (i: number) => uid(200 + i), gabriel: uid(301) };
const aiRole = (role: 'student' | 'mentor' | 'analysis'): z.infer<typeof S.AiRoleSetting> => ({ role, key_source: role === 'student' ? 'own' : 'student', provider: null, key_masked: null, key_added_at: null, model: null, effort: null });

export function seedDb(now = '2026-10-21T00:00:00.000Z'): Db {
  const user = (i: number, nickname: string, created: string, pw: string): UserRow => ({ id: SEED_IDS.u(i), nickname, password: 'demo123!', role: 'teacher', created_at: `${created}T00:00:00.000Z`, pw_updated_at: `${pw}T00:00:00.000Z` });
  const { desc: koDesc, ...ko } = gabrielTr.ko as typeof gabrielTr.ko & { desc: string }, { desc: enDesc, ...en } = gabrielTr.en as typeof gabrielTr.en & { desc: string };
  return {
    users: [
      { id: SEED_IDS.admin, nickname: 'admin', password: 'admin12!', role: 'admin', created_at: now, pw_updated_at: now },
      user(1, '하늘쌤', '2026-09-01', '2026-09-01'), user(2, '수학곰', '2026-09-01', '2026-10-02'), user(3, '분수탐험가', '2026-09-01', '2026-09-15'), user(4, '도토리', '2026-09-03', '2026-09-03'),
      user(5, '새벽별', '2026-09-03', '2026-10-11'), user(6, 'MapleT', '2026-09-20', '2026-09-20'), user(7, '민트초코', '2026-10-20', '2026-10-20'),
    ],
    // ponytail: 프로토타입은 가브리엘만 싣는다. 노아·지우·하준은 db/seed/samples/ 로 옮길 때 함께 (이 목록의 scenario_ids 도 그때 채운다)
    groups: [
      { id: SEED_IDS.g(1), name: '2학년 수학교육 A반', member_ids: [SEED_IDS.u(1), SEED_IDS.u(2), SEED_IDS.u(3)], scenario_ids: [SEED_IDS.gabriel] },
      { id: SEED_IDS.g(2), name: '2학년 수학교육 B반', member_ids: [SEED_IDS.u(4), SEED_IDS.u(5)], scenario_ids: [SEED_IDS.gabriel] },
      { id: SEED_IDS.g(3), name: '국제교류 (English)', member_ids: [SEED_IDS.u(6), SEED_IDS.u(1)], scenario_ids: [] },
      { id: SEED_IDS.g(4), name: '3학년 심화 (준비 중)', member_ids: [SEED_IDS.u(3)], scenario_ids: [] },
    ],
    scenarios: [{
      id: SEED_IDS.gabriel, slug: 'gabriel', status: 'published', created_at: now, updated_at: now,
      lang: 'ko', student_prefix: gabriel.student_prefix, mentor_prefix: gabriel.mentor_prefix, grade: gabriel.grade,
      internal: gabriel.internal, classification: gabriel.classification,
      translations: { ko: { ...ko, description: koDesc }, en: { ...en, description: enDesc } },
      compiled_prompt: { student: '<student system>', analysis: '<analysis system>', mentor: '<mentor system>' }, // MOCK 은 내용을 읽지 않는다(티켓 12 (A)). 실제 시드는 compileScenario 결과
    }],
    sessions: [], turns: [], login: { teacher: null, admin: null },
    ai: { student: aiRole('student'), mentor: aiRole('mentor'), analysis: aiRole('analysis') },
  };
}
