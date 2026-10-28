// [CLASSIFICATION] 블록 파서. 실 LLM 출력과 MOCK 출력이 같은 함수를 지난다(ADR-0001·0002).
import type { Criteria } from './adapter.ts';

export interface Classification { leverage: string; object: string | null }

/** 블록 뒤 첫 JSON 객체를 읽는다. 미지 키는 무시(후일 targets_misconception 대비). 분류명이 기준에 없거나 JSON 이 깨지면 null → 파이프라인이 1회 재요청. */
export function parseClassification(text: string, criteria: Criteria): Classification | null {
  const at = text.indexOf('[CLASSIFICATION]'); if (at < 0) return null;
  const open = text.indexOf('{', at), close = text.indexOf('}', open); if (open < 0 || close < 0) return null;
  let j: unknown; try { j = JSON.parse(text.slice(open, close + 1)); } catch { return null; }
  if (typeof j !== 'object' || j === null) return null;
  const { leverage, object } = j as Record<string, unknown>;
  if (typeof leverage !== 'string' || !criteria.leverage.some(r => r.name === leverage)) return null;
  const hasObj = criteria.object.length > 0;
  if (hasObj && (typeof object !== 'string' || !criteria.object.some(r => r.name === object))) return null;
  return { leverage, object: hasObj ? (object as string) : null };
}

export function renderClassification(c: Classification): string {
  return `[CLASSIFICATION]\n{\n  "leverage": ${JSON.stringify(c.leverage)}${c.object ? `,\n  "object": ${JSON.stringify(c.object)}` : ''}\n}`;
}
