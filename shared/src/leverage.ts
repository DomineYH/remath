// 표준 레버리지 이름과 멘토 트리거 번호 — 엔진 판정·MOCK·리포트 화면이 같은 상수를 본다.
/** 엔진이 의미를 두는 세 레버리지(그 밖의 분류명은 시나리오 데이터). */
export const LEVERAGE = { takingOver: 'Taking Over', eliciting: 'Eliciting', extending: 'Extending' } as const;
/** 1 = 주도권 빼앗기(Taking Over), 2 = 도움 요청, 3 = 도달점 도달. */
export const TRIGGER = { takingOver: 1, help: 2, goal: 3 } as const;
export type Trigger = typeof TRIGGER[keyof typeof TRIGGER];
