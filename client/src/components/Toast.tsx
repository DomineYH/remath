import { useEffect, useState } from 'react';

// 전역 토스트 하나: toast(text) 로 띄우고 2.6초 뒤 숨긴다(목업과 같다).
let show: (text: string) => void = () => {};
export const toast = (text: string) => show(text);

export function Toast() {
  const [text, setText] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    show = t => { setText(t); clearTimeout(timer); timer = setTimeout(() => setText(''), 2600); };
    return () => { clearTimeout(timer); show = () => {}; };
  }, []);
  return <div className="toast" role="status" aria-live="polite" hidden={!text}>{text}</div>;
}
