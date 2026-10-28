// 대화 화면 부품(I-50): 머리글·문제·대화 로그·말풍선·분류 블록·시스템 줄·빠른 질문·입력란. 상태는 ChatScreen 이 가진다.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';
import { useDismiss } from './useDismiss.ts';

/** 챗봇 언어 쪽 문구(화면 언어와 무관): 목업 TXT 의 입력란 안내·빠른 질문 5개. */
const CHAT_TXT = {
  ko: { ph: '학생에게 질문해 보세요… (예: 그림을 어떻게 그렸는지 말해 줄래?)', chips: ['안녕, 네 이름이 뭐야?', '어떻게 풀었는지 말해 줄래?', '그림은 어떻게 그렸어?', '도와줘', 'END SESSION'] },
  en: { ph: 'Ask the student a question… (e.g., Can you tell me how you drew your picture?)', chips: ['Hi, what’s your name?', 'Can you tell me how you solved it?', 'How did you draw your picture?', 'Help', 'END SESSION'] },
} as const;
export type ChatLang = keyof typeof CHAT_TXT;

interface HeaderProps {
  avatar: string; name: string; description: string;
  /** 분류 기준이 없으면 토글을 그리지 않는다. */
  showCls: boolean | null; onShowCls: (on: boolean) => void;
  onEnd: () => void; endDisabled: boolean; endPrimary: boolean; onBack: () => void;
}

/** 도구 3개(분류 토글·세션 종료·다른 학생). ≤640px 에서는 ⋯ 메뉴 하나로 접힌다(CSS). */
export function ChatHeader({ avatar, name, description, showCls, onShowCls, onEnd, endDisabled, endPrimary, onBack }: HeaderProps) {
  const t = useT(), [open, setOpen] = useState(false), box = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, box, btn);
  const pick = (f: () => void) => () => { setOpen(false); f(); };
  return (
    <div className="chat-h">
      <div className="av" aria-hidden="true">{avatar}</div>
      <div><b>{name}</b><small>{description}</small></div>
      <div className="tools">
        {showCls !== null && <label className="toggle"><input type="checkbox" checked={showCls} onChange={e => onShowCls(e.target.checked)} /> <span>{t('showCls')}</span></label>}
        <Button size="sm" variant={endPrimary ? 'primary' : 'default'} onClick={onEnd} disabled={endDisabled}>{t('endBtn')}</Button>
        <Button size="sm" onClick={onBack}>{t('otherStudent')}</Button>
      </div>
      <div className="more" ref={box}>
        <button ref={btn} type="button" className="btn sm" aria-haspopup="menu" aria-expanded={open} aria-label={t('chatTools')} onClick={() => setOpen(o => !o)}>⋯</button>
        {open && (
          <div className="acct-menu" role="menu">
            {showCls !== null && <button type="button" role="menuitemcheckbox" aria-checked={showCls} onClick={pick(() => onShowCls(!showCls))}>{showCls ? '☑' : '☐'} {t('showCls')}</button>}
            <button type="button" role="menuitem" disabled={endDisabled} onClick={pick(onEnd)}>{t('endBtn')}</button>
            <button type="button" role="menuitem" onClick={pick(onBack)}>{t('otherStudent')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ProblemBox({ problem }: { problem: string }) {
  const t = useT();
  return <div className="problem"><p className="eyebrow">{t('mathProblem')}</p><p>{problem}</p></div>;
}

/** 새 내용이 붙을 때마다 맨 아래로 스크롤한다. */
export function TurnLog({ children, size }: { children: ReactNode; size: number }) {
  const t = useT(), ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [size]);
  return <div className="log" ref={ref} role="log" aria-label={t('logAria')}>{children}</div>;
}

export type Speaker = 'teacher' | 'student' | 'mentor';
export function Turn({ speaker, avatar, name, text, children }: { speaker: Speaker; avatar: string; name: string; text: string; children?: ReactNode }) {
  return (
    <div className={`msg ${speaker === 'teacher' ? 'me' : speaker}`}>
      <div className="pf" aria-hidden="true">{avatar}</div>
      <div className="b"><span className="nm">{name}</span><div className="bub">{text}</div>{children}</div>
    </div>
  );
}

/** 예비교사 발화의 분류 결과. 토글이 꺼져 있으면 숨긴다. */
export function ClassificationBlock({ leverage, object, show }: { leverage: string; object: string | null; show: boolean }) {
  return (
    <div className="cls" hidden={!show}>
      {/* eslint-disable no-restricted-syntax -- the [CLASSIFICATION] block is machine format, not copy */}
      {'[CLASSIFICATION]\n{\n  '}<span className="k">"leverage"</span>{`: "${leverage}"`}
      {object !== null && <>{',\n  '}<span className="k">"object"</span>{`: "${object}"`}</>}
      {'\n}'}
      {/* eslint-enable no-restricted-syntax */}
    </div>
  );
}

export function SystemLine({ children }: { children: ReactNode }) {
  return <div className="sys">{children}</div>;
}

export function QuickChips({ lang, disabled, onPick }: { lang: ChatLang; disabled: boolean; onPick: (text: string) => void }) {
  const t = useT();
  return (
    <div className="chips" role="group" aria-label={t('chipsAria')}>
      {CHAT_TXT[lang].chips.map(c => <button key={c} type="button" disabled={disabled} onClick={() => onPick(c)}>{c}</button>)}
    </div>
  );
}

export function Composer({ lang, value, onChange, onSend, disabled, inputRef }: { lang: ChatLang; value: string; onChange: (v: string) => void; onSend: (text: string) => void; disabled: boolean; inputRef: RefObject<HTMLInputElement> }) {
  const t = useT();
  return (
    <form className="compose" onSubmit={e => { e.preventDefault(); if (value.trim()) onSend(value.trim()); }}>
      <input ref={inputRef} autoComplete="off" aria-label={t('msgAria')} placeholder={CHAT_TXT[lang].ph} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} maxLength={2000} />
      <Button variant="primary" type="submit" disabled={disabled}>{t('sendBtn')}</Button>
    </form>
  );
}
