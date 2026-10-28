import { useId, useState, type ChangeEvent } from 'react';
import { useT } from '../i18n/index.tsx';
import { Field } from './Field.tsx';
import { PasswordRules } from './PasswordRules.tsx';

export interface PasswordValue { current?: string; next: string; confirm: string }

/** (현재 비밀번호) + 새 비밀번호·확인 + 규칙 3개. 계정 만들기·내 비밀번호 변경이 함께 쓴다. */
export function PasswordFields({ withCurrent, onChange }: { withCurrent?: boolean; onChange: (v: PasswordValue) => void }) {
  const t = useT(), id = useId();
  const [v, setV] = useState<PasswordValue>({ current: withCurrent ? '' : undefined, next: '', confirm: '' });
  const set = (k: keyof PasswordValue) => (e: ChangeEvent<HTMLInputElement>) => { const n = { ...v, [k]: e.target.value }; setV(n); onChange(n); };
  return (
    <>
      {withCurrent && (
        <Field label={t('curPw')} htmlFor={`${id}-cur`}>
          <input id={`${id}-cur`} type="password" autoComplete="current-password" value={v.current} onChange={set('current')} />
        </Field>
      )}
      <div className="row2">
        <Field label={t(withCurrent ? 'newPw' : 'pw')} htmlFor={`${id}-pw`}>
          <input id={`${id}-pw`} type="password" autoComplete="new-password" value={v.next} onChange={set('next')} />
        </Field>
        <Field label={t('pw2')} htmlFor={`${id}-pw2`}>
          <input id={`${id}-pw2`} type="password" autoComplete="new-password" value={v.confirm} onChange={set('confirm')} />
        </Field>
      </div>
      <PasswordRules value={v.next} />
    </>
  );
}
