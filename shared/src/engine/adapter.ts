// 공급자 어댑터 인터페이스 (티켓 12). 서버 턴 파이프라인이 보는 유일한 LLM 경계.
// 실 어댑터 3종(3단계)과 MOCK_LLM 어댑터가 모두 이 인터페이스를 구현한다.

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

/** 3사 `event: error` 와 HTTP 오류를 평탄화한 형태. 어댑터는 재시도하지 않고 던진다. 재시도 여부는 파이프라인이 정한다. */
export class AdapterError extends Error {
  provider: ProviderId; code: string; status?: number; retryable: boolean;
  constructor(provider: ProviderId, code: string, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message); this.name = 'AdapterError'; this.provider = provider; this.code = code; this.status = opts.status; this.retryable = opts.retryable ?? false;
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

/** ADR-0002 이번 턴 지시. 서버가 정하고 런타임 블록으로 렌더링한다. aha 는 교정 대사 + 아하 대사를 한 응답으로 낸다. */
export type TurnDirective = { kind: 'hesitation' | 'correction' | 'aha' | 'confused'; text: string };

export interface ClassificationRow { name: string; desc?: string; ex?: string }
export interface Criteria { leverage: ClassificationRow[]; object: ClassificationRow[] }

/** 서버가 계산한 종료 리포트 중 분석 챗봇 입력에 들어가는 부분(티켓 14 추천안: JSON 문자열 한 덩어리). */
export interface ReportInput { names: string[]; counts: Record<string, number>; verdict: 'dist' | 'none' | 'clean' | 'heavy' | 'mixed'; reached: boolean }

export type MockContext =
  | { role: 'student'; lang: Lang; teacherText: string; leverage: string | null; directive: TurnDirective | null; goalReached: boolean; lines: { greet: string; chars: string; elicit: string[] } }
  | { role: 'analysis'; lang: Lang; purpose: 'turn'; teacherText: string; criteria: Criteria }
  | { role: 'analysis'; lang: Lang; purpose: 'report'; report: ReportInput }
  | { role: 'mentor'; lang: Lang; trigger: 1 | 2 | 3; lines: { t1: string; t2: string; t3: string } };
