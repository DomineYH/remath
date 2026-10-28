import type { ReactNode } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';
import { Modal } from './Modal.tsx';

type Turn = z.infer<typeof S.Turn>;
const SPEAKER = { teacher: 'spTeacher', student: 'spStudent', mentor: 'spMentor' } as const;

/** 전체 대화: 발화마다 번호·화자 + [레버리지 · 대상] 태그, 그 아래 report 슬롯(내 기록 = SessionReport, I-47·I-53). */
export function TranscriptModal({ open, title, sub, turns, report, onClose }: { open: boolean; title: string; sub?: string; turns: Turn[]; report?: ReactNode; onClose: () => void }) {
  const t = useT();
  return (
    <Modal open={open} title={title} onClose={onClose} actions={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}>
      {sub && <p className="hint mono">{sub}</p>}
      <div className="tx">
        {turns.map(x => (
          <div key={x.seq} className={`ln ${x.speaker}`}>
            <span className="sp">{x.seq}. {t(SPEAKER[x.speaker])}{x.leverage && <> <span className="tag">[{x.leverage}{x.object && ` · ${x.object}`}]</span></>}</span>
            {x.text}
          </div>
        ))}
      </div>
      {report}
    </Modal>
  );
}
