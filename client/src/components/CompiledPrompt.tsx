import type * as S from '@remath/shared';
import type { z } from 'zod';
import { useT } from '../i18n/index.tsx';

/** 컴파일된 세 프롬프트 전문, 학생→분석→멘토 순(I-43·I-44 7단계). 분류 기준이 없으면 분석 자리는 "컴파일 안 함". */
export function CompiledPrompt({ compiled }: { compiled: z.infer<typeof S.Compiled> }) {
  const t = useT();
  const parts = [['promptStudent', compiled.student], ['promptAnalysis', compiled.analysis], ['promptMentor', compiled.mentor]] as const;
  return parts.map(([title, text]) => (
    <section key={title} className="prompt-part">
      <h4>{t(title)}</h4>
      {text === null ? <p className="muted">{t('notCompiled')}</p> : <pre className="prompt">{text}</pre>}
    </section>
  ));
}
