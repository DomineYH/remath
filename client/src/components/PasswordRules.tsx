import { passwordChecks } from '@remath/shared';
import { useT } from '../i18n/index.tsx';

/** 규칙 3개를 실시간으로 ok/no. 빈 값이면 중립. 판정은 shared 의 Password 와 같은 함수. */
export function PasswordRules({ value }: { value: string }) {
  const t = useT(), checks = passwordChecks(value);
  return (
    <ul className="pwrules">
      {(['r1', 'r2', 'r3'] as const).map((k, i) => <li key={k} className={value ? (checks[i] ? 'ok' : 'no') : undefined}>{t(k)}</li>)}
    </ul>
  );
}
