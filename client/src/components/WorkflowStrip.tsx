import { useT } from '../i18n/index.tsx';

const STEPS = [['f1t', 'f1d'], ['f2t', 'f2d'], ['f3t', 'f3d'], ['f4t', 'f4d'], ['f5t', 'f5d']] as const;

/** 시나리오 목록 위 정적 5단계(작성→조립→검수→연습→리포트). ≤640px 숨김(I-43). */
export function WorkflowStrip() {
  const t = useT();
  return (
    <ol className="flow" aria-label={t('flowAria')}>
      {STEPS.map(([title, desc], i) => <li key={title}><i>{i + 1}</i><b>{t(title)}</b><small>{t(desc)}</small></li>)}
    </ol>
  );
}
