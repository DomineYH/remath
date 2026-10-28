// 위자드 단계 패널 7개(I-44). 상태는 화면(ScenarioWizard)이 ScenarioInput 모양 하나로 들고, 패널은 활성 언어판(tr)과 공용 설정만 고친다.
import type { ReactNode } from 'react';
import defaults from '@remath/seed/classification.json';
import presets from '@remath/seed/emoji-presets.json';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { useLang, useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';
import { CompiledPrompt } from './CompiledPrompt.tsx';
import { Field } from './Field.tsx';
import { Notice } from './Notice.tsx';
import { StatusChip } from './StatusChip.tsx';

export type Draft = z.infer<typeof S.ScenarioInput>;
type Tr = Draft['translations']['ko'];
type Row = Draft['classification']['leverage'][number];
export interface Edit { d: Draft; tr: Tr; set: (p: Partial<Draft>) => void; setTr: (p: Partial<Tr>) => void; setIn: (p: Partial<Draft['internal']>) => void }

function Panel({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return <section className="panel"><h3>{title}</h3><p className="lead">{lead}</p>{children}</section>;
}
/** 한 칸짜리 입력. area = textarea. */
function Text({ id, label, spine, hint, placeholder, value, onChange, area }: { id: string; label: string; spine?: string; hint?: string; placeholder?: string; value: string; onChange: (v: string) => void; area?: boolean }) {
  const p = { id, value, placeholder, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  return <Field label={label} htmlFor={id} spine={spine} hint={hint}>{area ? <textarea {...p} /> : <input {...p} />}</Field>;
}

/** 프리셋 이모지만 고른다(D-22): 학생 = 동물, 멘토 = 사물. */
function EmojiSelect({ id, kind, value, onChange }: { id: string; kind: 'student' | 'mentor'; value: string; onChange: (v: string) => void }) {
  const { lang } = useLang();
  return <select id={id} className="emoji-sel" value={value} onChange={e => onChange(e.target.value)}>{presets[kind].map(p => <option key={p.emoji} value={p.emoji}>{p.emoji} {p[lang]}</option>)}</select>;
}
export const firstEmoji = (kind: 'student' | 'mentor') => presets[kind][0].emoji;

export function StepProfile({ e }: { e: Edit }) {
  const t = useT(), { d, tr, set, setTr } = e;
  return (
    <Panel title={t('s1t')} lead={t('s1l')}>
      <div className="row2">
        <Field label={t('lStudentEmoji')} htmlFor="f-prefix" spine="STUDENT_PREFIX"><EmojiSelect id="f-prefix" kind="student" value={d.student_prefix} onChange={v => set({ student_prefix: v })} /></Field>
        {/* mentor_prefix 는 어떤 템플릿에도 주입되지 않는다(F-30): 칩 없음 */}
        <Field label={t('lMentorEmoji')} htmlFor="f-mprefix"><EmojiSelect id="f-mprefix" kind="mentor" value={d.mentor_prefix} onChange={v => set({ mentor_prefix: v })} /></Field>
      </div>
      <div className="prefix-prev">
        <span className="eyebrow">{t('prevHead')}</span>
        <span>{d.student_prefix} {tr.name || t('defaultStudent')}: {t('prevStudent')}</span>
        <span>{d.mentor_prefix} {t('mentor')}: {t('prevMentor')}</span>
      </div>
      <div className="row2">
        <Text id="f-name" label={t('lName')} spine="STUDENT_NAME" placeholder={t('pName')} value={tr.name} onChange={v => setTr({ name: v })} />
        <Text id="f-grade" label={t('lGrade')} placeholder={t('pGrade')} value={d.grade} onChange={v => set({ grade: v })} />
      </div>
      <Text id="f-desc" label={t('lDesc')} spine="STUDENT_SHORT_DESC" placeholder={t('pDesc')} value={tr.description} onChange={v => setTr({ description: v })} />
      <Text id="f-char" area label={t('lChar')} spine="CHARACTERISTICS" hint={t('hChar')} placeholder={t('pChar')} value={tr.chars} onChange={v => setTr({ chars: v })} />
      <Text id="f-greet" label={t('lGreet')} placeholder={t('pGreet')} value={tr.greet} onChange={v => setTr({ greet: v })} />
    </Panel>
  );
}

export function StepProblem({ e }: { e: Edit }) {
  const t = useT(), { d, tr, setTr, setIn } = e;
  return (
    <Panel title={t('s2t')} lead={t('s2l')}>
      <Text id="f-problem" area label={t('lProblem')} spine="MATH_PROBLEM" value={tr.problem} onChange={v => setTr({ problem: v })} />
      <Text id="f-baseline" area label={t('lBaseline')} spine="BASELINE_SOLUTION" placeholder={t('pBaseline')} value={d.internal.baseline} onChange={v => setIn({ baseline: v })} />
      <Text id="f-drawing" area label={t('lDrawing')} spine="DRAWING_DESCRIPTION" value={d.internal.drawing} onChange={v => setIn({ drawing: v })} />
    </Panel>
  );
}

/** 오개념 i 번 = internal.misconceptions[i].text(공용) + 활성 언어판 misconceptions[i] {kw,h,c}. 추가·삭제는 세 배열을 함께 바꾼다(스키마 refine). */
function MisconceptionList({ e }: { e: Edit }) {
  const t = useT(), { d, tr, set, setTr } = e, mis = d.internal.misconceptions;
  const add = () => set({ internal: { ...d.internal, misconceptions: [...mis, { text: '' }] }, translations: { ko: { ...d.translations.ko, misconceptions: [...d.translations.ko.misconceptions, { kw: '', h: '', c: '' }] }, en: { ...d.translations.en, misconceptions: [...d.translations.en.misconceptions, { kw: '', h: '', c: '' }] } } });
  const drop = <X,>(xs: X[], i: number) => xs.filter((_, j) => j !== i);
  const remove = (i: number) => set({ internal: { ...d.internal, misconceptions: drop(mis, i) }, translations: { ko: { ...d.translations.ko, misconceptions: drop(d.translations.ko.misconceptions, i) }, en: { ...d.translations.en, misconceptions: drop(d.translations.en.misconceptions, i) } } });
  const setText = (i: number, text: string) => set({ internal: { ...d.internal, misconceptions: mis.map((m, j) => j === i ? { text } : m) } });
  const setLine = (i: number, p: Partial<Tr['misconceptions'][number]>) => setTr({ misconceptions: tr.misconceptions.map((m, j) => j === i ? { ...m, ...p } : m) });
  return (
    <fieldset className="field">
      {/* eslint-disable-next-line no-restricted-syntax -- spine placeholder name */}
      <legend>{t('lMis')} <span className="spine">MISCONCEPTIONS_LIST</span></legend>
      {mis.map((m, i) => (
        <div className="mis" key={i}>
          <div className="mh"><b>{t('misHead', String(i + 1))}</b><Button size="sm" onClick={() => remove(i)} aria-label={`${t('del')} · ${t('misHead', String(i + 1))}`}>{t('del')}</Button></div>
          <Text id={`m-text-${i}`} label={t('misText')} placeholder={t('misTextP')} value={m.text} onChange={v => setText(i, v)} />
          <Text id={`m-kw-${i}`} label={t('misKw')} hint={t('misKwH')} placeholder={t('misKwP')} value={tr.misconceptions[i].kw} onChange={v => setLine(i, { kw: v })} />
          <div className="row2">
            <Text id={`m-h-${i}`} label={t('misH')} value={tr.misconceptions[i].h} onChange={v => setLine(i, { h: v })} />
            <Text id={`m-c-${i}`} label={t('misC')} value={tr.misconceptions[i].c} onChange={v => setLine(i, { c: v })} />
          </div>
        </div>
      ))}
      <div><Button size="sm" onClick={add}>{t('addMis')}</Button></div>
    </fieldset>
  );
}

export function StepReasoning({ e }: { e: Edit }) {
  const t = useT(), { d, tr, setTr, setIn } = e;
  return (
    <Panel title={t('s3t')} lead={t('s3l')}>
      <div className="row2">
        <Text id="f-reason" area label={t('lReason')} spine="REASONING_PROFILE" placeholder={t('pReason')} value={d.internal.reasoning} onChange={v => setIn({ reasoning: v })} />
        <Text id="f-never" area label={t('lNever')} spine="NEVER_UNDERSTANDS" placeholder={t('pNever')} value={d.internal.never} onChange={v => setIn({ never: v })} />
      </div>
      <Text id="f-goal" label={t('lGoal')} spine="PLATEAU_OR_GOAL" value={d.internal.goal} onChange={v => setIn({ goal: v })} />
      <Text id="f-aha" label={t('lAha')} value={tr.aha} onChange={v => setTr({ aha: v })} />
      <MisconceptionList e={e} />
      <Text id="f-prog" area label={t('lProg')} spine="PROGRESSION_RULE" value={d.internal.prog} onChange={v => setIn({ prog: v })} />
    </Panel>
  );
}

export function StepMentorTriggers({ e }: { e: Edit }) {
  const t = useT(), { tr, setTr } = e;
  return (
    <Panel title={t('s4t')} lead={t('s4l')}>
      <Text id="f-t1" area label={t('lT1')} value={tr.t1} onChange={v => setTr({ t1: v })} />
      <Text id="f-t2" area label={t('lT2')} hint={t('hOnePerLine')} value={tr.t2} onChange={v => setTr({ t2: v })} />
      <Text id="f-t3" area label={t('lT3')} value={tr.t3} onChange={v => setTr({ t3: v })} />
      {/* 빈 줄은 저장 때 버린다(cleanDraft). 입력 중에는 그대로 두어야 줄바꿈이 먹히지 않는다 */}
      <Text id="f-confused" area label={t('lConfused')} hint={t('hConfused')} value={tr.confused.join('\n')} onChange={v => setTr({ confused: v.split('\n') })} />
    </Panel>
  );
}

/** 분류 행 묶음. 세 칸의 placeholder 는 머리행 문구를 항상 둔다(≤700px 머리행이 숨어도 칸 뜻이 보이게, 티켓 17 #8). */
function ClassificationGroup({ title, hint, add, rows, onChange, tools }: { title: string; hint: string; add: string; rows: Row[]; onChange: (r: Row[]) => void; tools?: ReactNode }) {
  const t = useT(), up = (i: number, p: Partial<Row>) => onChange(rows.map((r, j) => j === i ? { ...r, ...p } : r));
  return (
    <>
      <div className="grp-h"><div><b>{title}</b> <span className="hint">{hint}</span></div>{tools}</div>
      <div className="clsrow head" aria-hidden="true"><span>{t('colName')}</span><span>{t('colWhen')}</span><span>{t('colEx')}</span><span /></div>
      <div className="clsgrid">
        {rows.map((r, i) => (
          <div className="clsrow" key={i}>
            <input className="c-name" value={r.name} placeholder={t('colName')} aria-label={`${title} ${i + 1} · ${t('colName')}`} onChange={e => up(i, { name: e.target.value })} />
            <textarea value={r.desc} placeholder={t('colWhen')} aria-label={`${title} ${i + 1} · ${t('colWhen')}`} onChange={e => up(i, { desc: e.target.value })} />
            <textarea value={r.ex} placeholder={t('colEx')} aria-label={`${title} ${i + 1} · ${t('colEx')}`} onChange={e => up(i, { ex: e.target.value })} />
            <Button size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`${t('del')} · ${title} ${i + 1}`}>{t('del')}</Button>
          </div>
        ))}
      </div>
      <Button size="sm" onClick={() => onChange([...rows, { name: '', desc: '', ex: '' }])}>{add}</Button>
    </>
  );
}

export function StepClassification({ e }: { e: Edit }) {
  const t = useT(), { d, set } = e, c = d.classification;
  const lev = c.leverage.filter(r => r.name.trim()).length, obj = c.object.filter(r => r.name.trim()).length;
  const setCls = (p: Partial<Draft['classification']>) => set({ classification: { ...c, ...p } });
  return (
    <Panel title={t('s5t')} lead={t('s5l')}>
      {lev ? <Notice tone="ok">{t('clsOnN', `${lev}|${obj}`)}</Notice> : <Notice tone="warn">{t('clsOffN', obj ? '1' : '')}</Notice>}
      <ClassificationGroup title={t('gLev')} hint={t('hLev')} add={t('addLev')} rows={c.leverage} onChange={leverage => setCls({ leverage })}
        tools={<div className="head-tools"><Button size="sm" onClick={() => set({ classification: structuredClone(defaults[d.lang]) })}>{t('loadDefault')}</Button><Button size="sm" onClick={() => set({ classification: { leverage: [], object: [] } })}>{t('clearAll')}</Button></div>} />
      <ClassificationGroup title={t('gObj')} hint={t('hObj')} add={t('addObj')} rows={c.object} onChange={object => setCls({ object })} />
    </Panel>
  );
}

export const MANUAL = ['m1', 'm2', 'm3', 'm4'] as const;
type Manual = (typeof MANUAL)[number];
export function StepReview({ review, hasCls, confirmed, onConfirm }: { review: z.infer<typeof S.ReviewResult>; hasCls: boolean; confirmed: Manual[]; onConfirm: (v: Manual[]) => void }) {
  const t = useT();
  return (
    <Panel title={t('s6t')} lead={t('s6l')}>
      <div className="checks" role="list" aria-label={t('autoAria')}>
        {review.auto.map(c => <div className="chk" role="listitem" key={c.id}><StatusChip status={c.status} /><span>{t(c.id === 'c6' ? (hasCls ? 'c6on' : 'c6off') : c.id)}</span></div>)}
      </div>
      <fieldset className="checks manual" aria-label={t('manualAria')}>
        {MANUAL.map(m => (
          <label className="chk" key={m}><input type="checkbox" checked={confirmed.includes(m)} onChange={e => onConfirm(e.target.checked ? [...confirmed, m] : confirmed.filter(x => x !== m))} /><span>{t(m)}</span></label>
        ))}
      </fieldset>
    </Panel>
  );
}

export function StepPreview({ compiled, auto, manual }: { compiled: z.infer<typeof S.Compiled>; auto: boolean; manual: boolean }) {
  const t = useT();
  return (
    <Panel title={t('s7t')} lead={t('s7l')}>
      {auto && manual ? <Notice tone="ok">{t('pubOk')}</Notice> : <Notice tone="warn">{t('pubWarn', `${+auto}|${+manual}`)}</Notice>}
      <CompiledPrompt compiled={compiled} />
    </Panel>
  );
}
