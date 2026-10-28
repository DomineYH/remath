// AI 설정 조각(I-48): 요약 타일 3개 + 챗봇 카드(키 출처 → KeyBox/KeyInput+KeyDetect → ModelSelect+직접 입력 → EffortRadios).
// 모델·effort 목록은 getProviders() 그대로. 1단계는 저장해도 마스킹만 남고 실제 호출은 없다.
import { useId, useState, type KeyboardEvent } from 'react';
import { detectProvider } from '@remath/shared';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { errorText, useT } from '../i18n/index.tsx';
import { localDate } from '../time.ts';
import { Button } from './Button.tsx';
import { Card } from './Card.tsx';
import { ErrorLine } from './ErrorLine.tsx';
import { Pill } from './Pill.tsx';
import { toast } from './Toast.tsx';

type Settings = z.infer<typeof S.AiSettings>;
type Setting = z.infer<typeof S.AiRoleSetting>;
type Providers = z.infer<typeof S.ProvidersFile>;
type Effort = z.infer<typeof S.Effort>;
export type Role = keyof Settings;
export const ROLES: Role[] = ['student', 'mentor', 'analysis'];
const NAME = { student: 'roleStudent', mentor: 'roleMentor', analysis: 'roleAnalysis' } as const;
const DESC = { student: 'roleStudentD', mentor: 'roleMentorD', analysis: 'roleAnalysisD' } as const;
const AVATAR = { student: '🦊', mentor: '🦉', analysis: '📊' };
const CUSTOM = '__custom';

/** 저장된 설정이 대화에 쓸 수 있는 상태인가(키가 있고 모델이 정해짐). */
const ready = (s: Setting) => !!(s.provider && s.model);

function Status({ s }: { s: Setting }) {
  const t = useT();
  return <Pill tone={ready(s) ? 'pub' : 'draft'}>{t(ready(s) ? 'stReady' : 'stNeedKey')}</Pill>;
}

export function AiSummaryTiles({ settings, providers }: { settings: Settings; providers: Providers }) {
  const t = useT();
  return (
    <div className="ai-sum">
      {ROLES.map(r => { const s = settings[r]; return (
        <div className="ai-tile" key={r}>
          <span className="eyebrow">{t(NAME[r])}</span>
          <b className="mono">{ready(s) ? `${providers[s.provider!].name} · ${s.model} · ${s.effort ?? t('defaultTag')}` : t('notSet')}</b>
          <Status s={s} />
        </div>
      ); })}
    </div>
  );
}

/** 저장된 키: 공급자·마스킹(긴 값도 줄바꿈, overflow-wrap:anywhere)·등록일 + 키 변경. */
function KeyBox({ s, providers, onChange }: { s: Setting; providers: Providers; onChange: () => void }) {
  const t = useT();
  return (
    <div className="keybox">
      <Pill tone="lang">{providers[s.provider!].name}</Pill>
      <span className="mono">{s.key_masked}</span>
      <span className="hint">{t('keyAdded', localDate(s.key_added_at!))}</span>
      <Button size="sm" onClick={onChange}>{t('changeKey')}</Button>
    </div>
  );
}

/** 붙여 넣는 즉시 접두어로 공급자를 보여 준다(KeyDetect). 원문은 저장 요청에만 실리고 저장 뒤 비운다. */
function KeyInput({ value, providers, onChange, onCancel }: { value: string; providers: Providers; onChange: (v: string) => void; onCancel?: () => void }) {
  const t = useT(), id = useId(), typed = value.trim(), p = typed ? detectProvider(typed) : null;
  return (
    <div className="field">
      <label htmlFor={id}>{t('keyLabel')}</label>
      <div className="keyrow">
        {/* eslint-disable-next-line no-restricted-syntax -- key prefixes, not copy */}
        <input id={id} type="password" autoComplete="off" spellCheck={false} placeholder="sk-… / sk-ant-… / AIza…" value={value} onChange={e => onChange(e.target.value)} />
        {onCancel && <Button onClick={onCancel}>{t('cancel')}</Button>}
      </div>
      <p className={`kdet ${typed ? (p ? 'ok' : 'bad') : ''}`} aria-live="polite">{!typed ? t('waitingKey') : p ? t('detected', providers[p].name) : t('undetected')}</p>
    </div>
  );
}

function ModelSelect({ provider, pick, custom, onPick, onCustom }: { provider: Providers[keyof Providers]; pick: string; custom: string; onPick: (v: string) => void; onCustom: (v: string) => void }) {
  const t = useT(), id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{t('model')} <Pill tone="lang">{provider.name}</Pill></label>
      <select id={id} value={pick} onChange={e => onPick(e.target.value)}>
        {provider.models.map(m => <option key={m.id} value={m.id}>{m.id}{m.recommended ? ` · ${t('recTag')}` : ''}</option>)}
        <option value={CUSTOM}>{t('customModel')}</option>
      </select>
      {pick === CUSTOM && <input aria-label={t('customModel')} value={custom} placeholder={t('customPh')} spellCheck={false} onChange={e => onCustom(e.target.value)} style={{ marginTop: 6 }} />}
    </div>
  );
}

/** role=radiogroup: 탭 정지 하나, 화살표로 이동(WAI-ARIA radio 패턴). 아무것도 안 고르면 null = 공급자 기본값. */
function EffortRadios({ efforts, value, def, param, onChange }: { efforts: Effort[]; value: Effort | null; def: Effort | null; param: string; onChange: (e: Effort) => void }) {
  const t = useT();
  const key = (i: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const d = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (!d) return;
    e.preventDefault();
    const j = (i + d + efforts.length) % efforts.length;
    onChange(efforts[j]); (e.currentTarget.parentElement!.children[j] as HTMLElement).focus();
  };
  const focusable = value && efforts.includes(value) ? value : efforts[0];
  return (
    <div className="field">
      <label>{t('effort')} <span className="hint mono">{t('paramHint', param)}</span></label>
      <div className="effs" role="radiogroup" aria-label={t('effort')}>
        {efforts.map((e, i) => (
          <button key={e} type="button" role="radio" aria-checked={e === value} tabIndex={e === focusable ? 0 : -1} onClick={() => onChange(e)} onKeyDown={ev => key(i, ev)}>
            {e}{e === def && <small>{t('defaultTag')}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 챗봇 하나. 입력은 이 카드 안의 초안이고 "저장" 한 번이 PUT /api/admin/ai/:role 하나(감사 ai.update 1행). */
export function AiBotCard({ role, settings, providers, onSaved }: { role: Role; settings: Settings; providers: Providers; onSaved: () => void }) {
  const t = useT(), id = useId(), s = settings[role];
  const listed = (m: string | null) => !!(m && s.provider && providers[s.provider].models.some(x => x.id === m));
  const [src, setSrc] = useState(s.key_source), [editing, setEditing] = useState(false), [key, setKey] = useState('');
  const [pick, setPick] = useState(listed(s.model) ? s.model! : s.model ? CUSTOM : ''), [custom, setCustom] = useState(listed(s.model) ? '' : s.model ?? '');
  const [effort, setEffort] = useState<Effort | null | undefined>(s.effort ?? undefined);   // undefined = 모델 기본값을 따른다
  const [err, setErr] = useState('');

  const own = src === 'own', hasKey = s.key_source === 'own' && !!s.key_masked, typed = key.trim(), detected = typed ? detectProvider(typed) : null;
  const shared = own ? null : settings[src];
  const provider = own ? (typed ? detected : hasKey ? s.provider : null) : shared!.key_source === 'own' ? shared!.provider : null;
  const P = provider ? providers[provider] : null, isCustom = pick === CUSTOM;
  const m = P && !isCustom ? P.models.find(x => x.id === pick) ?? P.models.find(x => x.recommended) ?? P.models[0] : undefined;
  const efforts = P ? (isCustom ? P.efforts : m!.efforts) : [];
  const def = m?.default_effort ?? null;
  const eff = effort === null || (effort && efforts.includes(effort)) ? effort : def;   // 목록에 없는 effort 는 기본값으로
  const model = isCustom ? custom.trim() : m?.id;
  const owners = ROLES.filter(r => r !== role && settings[r].key_source === 'own' && settings[r].key_masked);
  const sources = ['own', ...owners, ...(own || owners.includes(src as Role) ? [] : [src])] as Setting['key_source'][];

  const save = async () => {
    if (!P || !model) return;
    try {
      await adminApi.updateAiRole(role, { key_source: src, api_key: own && typed ? typed : undefined, model, effort: eff });
      setKey(''); setEditing(false); setErr(''); toast(t('aiSaved')); onSaved();
    } catch (e) { setErr(errorText(t, e)); }
  };
  return (
    <Card title={t(NAME[role])} sub={t(DESC[role])} avatar={AVATAR[role]} badge={<Status s={s} />}
      actions={<Button variant="primary" onClick={save} disabled={!P || !model || (!!typed && !detected)}>{t('save')}</Button>}>
      <div className="field">
        <label htmlFor={id}>{t('keySrc')}</label>
        <select id={id} value={src} onChange={e => setSrc(e.target.value as Setting['key_source'])}>
          {sources.map(v => <option key={v} value={v}>{v === 'own' ? t('srcOwn') : t('srcShare', t(NAME[v]))}</option>)}
        </select>
      </div>
      {own
        ? hasKey && !editing
          ? <KeyBox s={s} providers={providers} onChange={() => setEditing(true)} />
          : <KeyInput value={key} providers={providers} onChange={setKey} onCancel={hasKey ? () => { setEditing(false); setKey(''); } : undefined} />
        : <p className="hint">{provider ? <>{t('sharedFrom', t(NAME[src as Role]))} · <span className="mono">{shared!.key_masked}</span></> : t('sharedLost')}</p>}
      {P && <>
        <ModelSelect provider={P} pick={isCustom ? CUSTOM : m!.id} custom={custom} onPick={v => { setPick(v); setEffort(undefined); }} onCustom={setCustom} />
        <EffortRadios efforts={efforts} value={eff} def={def} param={P.param} onChange={setEffort} />
      </>}
      <ErrorLine message={err} />
    </Card>
  );
}
