import { useEffect, useId, useRef, type ReactNode } from 'react';

/** 네이티브 <dialog> 위의 얇은 껍데기: showModal 이 포커스 가두기·Esc·닫을 때 포커스 복원을 맡는다. 배경 클릭도 닫는다. */
export function Modal({ open, title, onClose, children, actions }: { open: boolean; title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={id} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      {open && (
        <>
          <h3 id={id}>{title}</h3>
          {children}
          {actions && <div className="m-acts">{actions}</div>}
        </>
      )}
    </dialog>
  );
}
