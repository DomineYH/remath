import { useId } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';

type Summary = z.infer<typeof S.ScenarioSummary>;

/** 이용 그룹 이름 나열, 없으면 "아무도 이용 불가" 경고 필(I-43). */
export function AccessLine({ groups }: { groups: string[] }) {
  const t = useT();
  return groups.length
    ? <div className="access"><span className="eyebrow">{t('assigned')}</span>{groups.join(', ')}</div>
    : <div className="access"><span className="pill draft">{t('noGroupWarn')}</span></div>;
}

/** 관리자 시나리오 카드. 편집·대화 CSV·대화 테스트는 핸들러가 없으면 비활성(다음 티켓에서 연결). */
export function ScenarioCard({ s, onViewPrompt, onEdit, onCsv, onTestChat }: { s: Summary; onViewPrompt: () => void; onEdit?: () => void; onCsv?: () => void; onTestChat?: () => void }) {
  const t = useT(), id = useId(), cls = s.classification_count;
  return (
    <article className="card" aria-labelledby={id}>
      <div className="who">
        <div className="av" aria-hidden="true">{s.student_prefix}</div>
        <div><h3 id={id}>{s.name}</h3><small>{s.grade}</small></div>
        <span className={`pill ${s.status === 'published' ? 'pub' : 'draft'}`} style={{ marginLeft: 'auto' }}>{t(s.status === 'published' ? 'pub' : 'draft')}</span>
      </div>
      <p className="prob">{s.problem}</p>
      <AccessLine groups={s.groups.map(g => g.name)} />
      <div className="meta">
        <span className="pill">{t('misN', String(s.misconception_count))}</span>
        <span className="pill">{t('trig3')}</span>
        <span className={`pill ${cls.leverage ? '' : 'draft'}`}>{cls.leverage ? t('clsCount', `${cls.leverage}·${cls.object}`) : t('clsOff')}</span>
        <span className="pill lang">{s.lang === 'en' ? 'English' : '한국어'}</span>
        <span className="mono">{t('updated', s.updated_at.slice(0, 10))}</span>
      </div>
      <div className="acts">
        <Button size="sm" onClick={onEdit} disabled={!onEdit}>{t('edit')}</Button>
        <Button size="sm" onClick={onViewPrompt}>{t('viewPrompt')}</Button>
        <Button size="sm" onClick={onCsv} disabled={!onCsv}>{t('csvBtn', String(s.session_count))}</Button>
        <Button size="sm" variant="primary" onClick={onTestChat} disabled={!onTestChat}>{t('testChat')}</Button>
      </div>
    </article>
  );
}
