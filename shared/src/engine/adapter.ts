// 공급자 어댑터 인터페이스 (티켓 12). 서버 턴 파이프라인이 보는 유일한 LLM 경계.
// 실 어댑터 3종(3단계)과 MOCK_LLM 어댑터가 모두 이 인터페이스를 구현한다.
import type { Trigger } from '../leverage.ts';

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'mock';
export type Lang = 'ko' | 'en';
export type Role = 'student' | 'analysis' | 'mentor';

/** 3사 허용값의 합집합. 모델별 허용 여부는 providers.json 으로 AI 설정 저장 시 검증하고, 어댑터는 그대로 보낸다(조사 티켓 3). 생략 = 공급자 기본값. */
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 3사 모두 system 은 최상위 필드라 messages 에는 user/assistant 만 둔다. */
export interface Message { role: 'user' | 'assistant'; content: string }

export interface CompleteRequest {
  system: string;
  messages: Message[];
  model: string;
  effort?: Effort;
  signal?: AbortSignal;
  /** MOCK_LLM 전용. 실 어댑터는 읽지 않는다(선택지 A). 파이프라인은 항상 채워 보낸다. */
  context?: MockContext;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; model: string; stopReason: 'end' | 'length' | 'other'; usage?: { input: number; output: number } };

/**
 * 공급자 오류 종류로 받는 모양: 한 가지 대소문자로만 된 짧은 식별자(전부 소문자 또는 전부 대문자, 64자 이하, 영숫자·`_`·`.`·`-`).
 * 공급자가 그 자리에 메시지를 넣어도 로그로 새지 않게 길이·문자를 제한하고(#89), 문서의 종류는 모두 한 가지 대소문자라
 * (OpenAI·Anthropic 소문자 snake_case, Gemini 대문자 UPPER_SNAKE) 대소문자가 섞인 값 — 무작위 API 키 모양 — 은 버린다(#89 리뷰 F1).
 */
const KIND = [/^[a-z0-9_.-]{1,64}$/, /^[A-Z0-9_.-]{1,64}$/];

/**
 * 3사 `event: error` 와 HTTP 오류를 평탄화한 형태. 어댑터는 재시도하지 않고 던진다. 재시도 여부는 파이프라인이 정한다.
 * kind = 공급자 오류 종류(OpenAI: error.code 가 문서 목록에 있으면 code, 아니면 목록에 있는 error.type(#93); Anthropic error.type,
 * Gemini error.status). 로그에 넣어도 되는 값만 담는다:
 * 64자 초과·영숫자·`_`·`.`·`-` 밖의 문자·대소문자 섞임이 있으면 저장하지 않는다(#89). 이 모양 규칙은 목·파이프라인 오류까지
 * 덮는 일반 규칙일 뿐 식별자임을 증명하지 못한다: 실 어댑터는 오류를 내보내기 전에 공급자 문서의 종류(LOGGED_KINDS)만 남기고 나머지는 지운다
 * (server/src/providers/call.ts outbound).
 */
export class AdapterError extends Error {
  provider: ProviderId; code: string; status?: number; retryable: boolean; kind?: string;
  constructor(provider: ProviderId, code: string, message: string, opts: { status?: number; retryable?: boolean; kind?: string } = {}) {
    super(message); this.name = 'AdapterError'; this.provider = provider; this.code = code; this.status = opts.status; this.retryable = opts.retryable ?? false;
    if (typeof opts.kind === 'string' && KIND.some(re => re.test(opts.kind as string))) this.kind = opts.kind;
  }
}

export interface Provider {
  readonly id: ProviderId;
  /** 텍스트 델타 스트림 뒤에 done 하나. 오류는 AdapterError 로 throw. */
  complete(req: CompleteRequest): AsyncIterable<StreamEvent>;
  /** 키 유효성 확인용 최소 호출(모델 목록 GET, 3사 모두 토큰 비과금 — 조사 티켓 3). */
  listModels(): Promise<string[]>;
}

/** 스트림을 한 문자열로 모은다(분석 챗봇처럼 전문이 필요할 때). */
export async function collect(stream: AsyncIterable<StreamEvent>): Promise<{ text: string; done: Extract<StreamEvent, { type: 'done' }> }> {
  let text = ''; let done: Extract<StreamEvent, { type: 'done' }> | undefined;
  for await (const ev of stream) { if (ev.type === 'delta') text += ev.text; else done = ev; }
  if (!done) throw new AdapterError('mock', 'no_done', 'stream ended without done event');
  return { text, done };
}

// ---- MOCK_LLM 컨텍스트: 서버 규칙 엔진의 판정 결과와 시나리오 대사만 담는다. 프롬프트 파싱 없음. ----

/** ADR-0002 이번 턴 지시. 서버가 정하고 런타임 블록으로 렌더링한다. aha 턴 지시는 아하 대사 한 줄이고, 비어 있으면 마지막 교정 대사(c)로 대신한다(#68). */
export type TurnDirective = { kind: 'hesitation' | 'correction' | 'aha' | 'confused'; text: string };

export interface ClassificationRow { name: string; desc?: string; ex?: string }
export interface Criteria { leverage: ClassificationRow[]; object: ClassificationRow[] }

/** 서버가 계산한 종료 리포트 중 분석 챗봇 입력에 들어가는 부분(티켓 14 추천안: JSON 문자열 한 덩어리). */
export interface ReportInput { names: string[]; counts: Record<string, number>; verdict: 'dist' | 'none' | 'clean' | 'heavy' | 'mixed'; reached: boolean }

export type MockContext =
  | { role: 'student'; lang: Lang; teacherText: string; leverage: string | null; directive: TurnDirective | null; goalReached: boolean; lines: { greet: string; chars: string; elicit: string[] } }
  | { role: 'analysis'; lang: Lang; purpose: 'turn'; teacherText: string; criteria: Criteria }
  | { role: 'analysis'; lang: Lang; purpose: 'report'; report: ReportInput }
  | { role: 'mentor'; lang: Lang; trigger: Trigger; lines: { t1: string; t2: string; t3: string } };
