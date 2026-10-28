import type { ReactNode } from 'react';
import { useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';
import { ErrorLine } from './ErrorLine.tsx';
import { Modal } from './Modal.tsx';

/** 되돌릴 수 없는 작업 확인: 본문 + (extraAction) · 취소 · 빨간 확인 버튼(dangerSolid). */
export function ConfirmModal({ open, title, body, confirmLabel, onConfirm, onClose, extraAction, error }: {
  open: boolean; title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void; extraAction?: ReactNode; error?: string;
}) {
  const t = useT();
  return (
    <Modal open={open} title={title} onClose={onClose}
      actions={<>{extraAction}<Button onClick={onClose}>{t('cancel')}</Button><Button variant="dangerSolid" onClick={onConfirm}>{confirmLabel}</Button></>}>
      <p>{body}</p>
      <ErrorLine message={error} />
    </Modal>
  );
}
