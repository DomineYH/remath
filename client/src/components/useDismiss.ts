import { useEffect, type RefObject } from 'react';

/** 열린 드롭다운을 Esc(포커스는 여는 버튼으로)·바깥 클릭으로 닫는다(티켓 17 #3, I-50). */
export function useDismiss(open: boolean, close: () => void, box: RefObject<HTMLElement | null>, button: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); button.current?.focus(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open, close, box, button]);
}
