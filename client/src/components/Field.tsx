import type { ReactNode } from 'react';
import { PlaceholderChip } from './PlaceholderChip.tsx';

/** `spine` = 이 값이 들어갈 스파인 플레이스홀더 이름(라벨 옆 칩, 위자드 전용). */
export function Field({ label, htmlFor, hint, spine, children }: { label: string; htmlFor: string; hint?: ReactNode; spine?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}{spine && <> <PlaceholderChip name={spine} /></>}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
