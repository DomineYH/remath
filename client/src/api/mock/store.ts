// 목 저장소 — 메모리 한 객체 + localStorage 한 키. 서버 테이블과 같은 이름·같은 snake_case 열(티켓 11, 0001_init.sql)이라 2단계에서 HTTP 로 바꿔도 화면은 모른다.
// 키는 목업(`remath.scen.v3` 등)과 다르게 새로 시작한다(모양이 다르고 섞이면 깨진다). 초기화 = 이 키 삭제.
import { compileScenario, TEMPLATES } from '@remath/prompts';
import gabriel from '@remath/seed/scenarios/gabriel.json';
import hajun from '@remath/seed/scenarios/hajun.json';
import jiwoo from '@remath/seed/scenarios/jiwoo.json';
import noah from '@remath/seed/scenarios/noah.json';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import * as S from '@remath/shared';
import type { z } from 'zod';

export const STORAGE_KEY = 'remath.mock.v1';

type Realm = 'teacher' | 'admin';
/** password_hash = crypto.ts 형식. 관리자 행은 null 로 시작한다: 그동안은 VITE_MOCK_ADMIN_PASSWORD 와 비교(G-33). */
export interface UserRow { id: string; nickname: string; password_hash: string | null; role: Realm; pw_updated_at: string; created_at: string; updated_at: string }
// ponytail: 서버는 sha256(token) 을 저장한다. 목의 쿠키 상자는 같은 localStorage 에 있어 해시가 보태는 것이 없다. 만료도 흉내 내지 않는다.
export interface AuthSessionRow { id: string; user_id: string; realm: Realm; token_hash: string; created_at: string }
export interface GroupRow { id: string; name: string; member_ids: string[]; scenario_ids: string[]; created_at: string; updated_at: string }
export type ScenarioRow = z.infer<typeof S.ScenarioInput> & { id: string; slug: string; status: 'draft' | 'published'; compiled_prompt: z.infer<typeof S.Compiled> | null; created_at: string; updated_at: string };
/** sessions 테이블. summary 열 없음(티켓 14: 분석 문장은 report.summary 에만). */
export interface SessionRow {
  id: string; user_id: string; scenario_id: string; lang: 'ko' | 'en'; started_at: string; ended_at: string | null; goal_reached: boolean;
  counts: Record<string, number>; progress: { mis: number[] }; report: z.infer<typeof S.SessionReport> | null; turn_started_at: string | null; created_at: string; updated_at: string;
}
export type TurnRow = z.infer<typeof S.Turn> & { session_id: string };
export interface Db {
  users: UserRow[]; auth_sessions: AuthSessionRow[]; groups: GroupRow[]; scenarios: ScenarioRow[]; sessions: SessionRow[]; turns: TurnRow[];
  audit_log: z.infer<typeof S.AuditEntry>[];
  login: { teacher: string | null; admin: string | null };   // 이 브라우저의 쿠키 2개 흉내: 실별 로그인 토큰
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
    // 저장본의 turn_started_at 은 새로고침으로 끊긴 턴의 흔적이다: 이 페이지에서 흐르는 턴은 아직 없다(목은 TURN_TIMEOUT_MS 를 흉내 내지 않는다).
    for (const s of this.db.sessions) s.turn_started_at = null;
  }
  save() { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.db)); }
}

export const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const aiRole = (role: 'student' | 'mentor' | 'analysis'): z.infer<typeof S.AiRoleSetting> => ({ role, key_source: role === 'student' ? 'own' : 'student', provider: null, key_masked: null, key_added_at: null, model: null, effort: null });

/** 샘플 시나리오 5개(H-38): 서버 시드(`--with-samples`)와 같은 JSON. 게시 상태로 싣고 compiled_prompt 는 게시와 같은 compileScenario 결과(G-33). */
const SAMPLES = { gabriel, noah, jiwoo, hajun, seoyeon };
const sample = (slug: string, json: unknown, now: string): ScenarioRow => {
  const s = S.ScenarioInput.parse(json);
  return { ...s, id: crypto.randomUUID(), slug, status: 'published', compiled_prompt: compileScenario(s, s.translations[s.lang], s.lang, TEMPLATES), created_at: now, updated_at: now };
};

/** 첫 실행 상태: 관리자 1명 + 샘플 시나리오 5개(그룹이 없어 예비교사에게는 안 보인다). 예비교사·그룹·기록 0, 데모 데이터 없음(G-33). */
export function seedDb(now: string): Db {
  return {
    users: [{ id: ADMIN_ID, nickname: 'admin', password_hash: null, role: 'admin', pw_updated_at: now, created_at: now, updated_at: now }],
    auth_sessions: [], groups: [], scenarios: Object.entries(SAMPLES).map(([slug, json]) => sample(slug, json, now)), sessions: [], turns: [], audit_log: [],
    login: { teacher: null, admin: null },
    ai: { student: aiRole('student'), mentor: aiRole('mentor'), analysis: aiRole('analysis') },
  };
}
