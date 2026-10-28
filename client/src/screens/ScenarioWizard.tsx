// 시나리오 위자드(I-44) `/admin/scenarios/new`·`/admin/scenarios/:id`. 폼 상태는 ScenarioInput 하나: 두 언어판을 모두 들고 있다가 저장 본문에 함께 보낸다.
// 6단계 점검·7단계 미리보기는 저장 전 폼을 클라이언트에서 판정·컴파일한다(F-31). 게시 때 목/서버가 같은 함수로 다시 판정한다.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { checkTemplates, compileScenario, TEMPLATES } from '@remath/prompts';
import seoyeon from '@remath/seed/scenarios/seoyeon.json';
import * as S from '@remath/shared';
import { adminApi } from '../apis.ts';
import { withDefaultElicit } from '../elicit.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { SegmentedToggle } from '../components/SegmentedToggle.tsx';
import { toast } from '../components/Toast.tsx';
import { firstEmoji, MANUAL, StepClassification, StepMentorTriggers, StepPreview, StepProblem, StepProfile, StepReasoning, StepReview, type Draft, type Edit } from '../components/WizardPanels.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

type Lang = Draft['lang'];
type Tr = Draft['translations']['ko'];
const LANG_NAME = { ko: '한국어', en: 'English' };
const STEPS = ['st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7'] as const;
const TEMPLATES_OK = checkTemplates(TEMPLATES).every(c => c.ok);

const emptyDraft = (): Draft => {
  const tr = S.Translation.parse({ misconceptions: [{ kw: '', h: '', c: '' }] });
  return { lang: 'ko', student_prefix: firstEmoji('student'), mentor_prefix: firstEmoji('mentor'), grade: '', internal: S.Internal.parse({ misconceptions: [{ text: '' }] }), classification: { leverage: [], object: [] }, translations: { ko: tr, en: structuredClone(tr) } };
};
/** 아직 아무것도 쓰지 않은 언어판인가: 언어 전환 때 현재 판을 옮겨 오는 기준(목업 동작). */
const blank = (t: Tr) => ![t.name, t.description, t.problem, t.chars, t.greet, t.aha, t.t1, t.t2, t.t3, ...t.confused, ...t.misconceptions.flatMap(m => [m.kw, m.h, m.c])].some(Boolean);
/** 저장·판정 전 정리: 빈 혼란 대사 줄, 설명 없는 오개념(세 배열의 같은 자리), 이름 없는 분류 행을 버린다. */
function cleanDraft(d: Draft): Draft {
  const keep = d.internal.misconceptions.map(m => !!m.text.trim());
  const tr = (t: Tr): Tr => ({ ...t, confused: t.confused.map(x => x.trim()).filter(Boolean), misconceptions: t.misconceptions.filter((_, i) => keep[i]) });
  const rows = (r: Draft['classification']['leverage']) => r.filter(x => x.name.trim()).map(x => ({ ...x, name: x.name.trim() }));
  return { ...d, internal: { ...d.internal, misconceptions: d.internal.misconceptions.filter((_, i) => keep[i]) }, classification: { leverage: rows(d.classification.leverage), object: rows(d.classification.object) }, translations: { ko: tr(d.translations.ko), en: tr(d.translations.en) } };
}

export function ScenarioWizard() {
  const t = useT(), me = useMe(), navigate = useNavigate(), { id } = useParams();
  const [d, setD] = useState<Draft | undefined>(() => (id ? undefined : emptyDraft())), [loadedName, setLoadedName] = useState(''), [published, setPublished] = useState(false), [savedId, setSavedId] = useState(id);
  const [step, setStep] = useState(0), [copied, setCopied] = useState(false), [confirmed, setConfirmed] = useState<(typeof MANUAL)[number][]>([]);
  const [err, setErr] = useState<unknown>(), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (id) adminApi.getScenario(id).then(s => { setD(S.ScenarioInput.parse(s)); setLoadedName(s.translations[s.lang].name); setPublished(s.status === 'published'); }, setErr);
  }, [id]);

  /** 문자열 = 화면이 만든 문구(이름 필수), 그 밖 = ApiError → 사전 문구. */
  const errMsg = err === undefined ? undefined : typeof err === 'string' ? err : errorText(t, err);
  const clean = useMemo(() => d && cleanDraft(d), [d]);
  const review = useMemo(() => clean && S.autoChecks(clean, TEMPLATES_OK), [clean]);
  if (!d || !clean || !review) return <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}><ErrorLine message={errMsg} /></AppShell>;

  const tr = d.translations[d.lang];
  const e: Edit = {
    d, tr, set: p => setD({ ...d, ...p }),
    setTr: p => setD({ ...d, translations: { ...d.translations, [d.lang]: { ...tr, ...p } } }),
    setIn: p => setD({ ...d, internal: { ...d.internal, ...p } }),
  };
  /** 언어별 필드만 바뀐다(내부 설정·분류는 그대로). 비어 있는 판으로 가면 지금 판의 폼 필드를 옮겨 오고 안내한다(elicit 은 폼에 없는 언어 대사라 비운다: 저장 때 그 언어 기본값). */
  const switchLang = (l: Lang) => {
    if (l === d.lang) return;
    const fresh = blank(d.translations[l]);
    setD({ ...d, lang: l, translations: fresh ? { ...d.translations, [l]: { ...structuredClone(tr), elicit: [] } } : d.translations });
    setCopied(fresh);
  };
  const fillExample = () => { setD({ ...S.ScenarioInput.parse(seoyeon), lang: d.lang }); setCopied(false); setConfirmed([]); };
  const canPublish = review.publishable && confirmed.length === MANUAL.length;

  /** 지금 판 elicit 이 비었으면 기본값을 채워 보낸다(#31). 새 시나리오는 한 번만 만들고, 그 뒤로는 같은 id 에 PUT(게시 실패 뒤 다시 눌러도 중복 생성 없음). */
  const save = async () => {
    if (!clean.translations[clean.lang].name.trim()) { setStep(0); setErr(t('nameRequired')); return null; }
    const body = withDefaultElicit(clean);
    const s = savedId ? await adminApi.updateScenario(savedId, body) : await adminApi.createScenario(body);
    setSavedId(s.id); setPublished(false);
    return s;
  };
  const run = (fn: () => Promise<unknown>) => async () => {
    setErr(undefined); setBusy(true);
    try { await fn(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const saveDraft = run(async () => { if (await save()) { toast(t('draftSaved')); navigate('/admin/scenarios'); } });
  const publish = run(async () => {
    const s = await save();
    if (!s) return;
    await adminApi.publishScenario(s.id, { confirmed });
    toast(t('publishedToast')); navigate('/admin/scenarios');
  });

  const L = LANG_NAME[d.lang], O = LANG_NAME[d.lang === 'ko' ? 'en' : 'ko'];
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <PageHead eyebrow={t('wizEyebrow')} title={loadedName ? t('wizEdit', loadedName) : t('wizNew')} lead={t('wizLead')} actions={
        <div className="wiz-tools head-tools">
          <SegmentedToggle ariaLabel={t('botLang')} label={t('botLang')} value={d.lang} onChange={switchLang} options={[{ value: 'ko', label: '한국어' }, { value: 'en', label: 'English' }]} />
          <Button onClick={fillExample}>{t('exampleBtn')}</Button>
          <Button onClick={() => navigate('/admin/scenarios')}>{t('backBtn')}</Button>
        </div>} />
      <Notice tone="info">{t('langNotice', L) + (copied ? t('langCopied', `${L}|${O}`) : blank(d.translations[d.lang === 'ko' ? 'en' : 'ko']) ? '' : t('langKept', O))}</Notice>
      {published && <Notice tone="warn">{t('unpublishNotice')}</Notice>}
      <div className="wiz">
        <WizardSteps current={step} onSelect={setStep} />
        <div>
          {[() => <StepProfile e={e} />, () => <StepProblem e={e} />, () => <StepReasoning e={e} />, () => <StepMentorTriggers e={e} />, () => <StepClassification e={e} />,
            () => <StepReview review={review} hasCls={clean.classification.leverage.length > 0} confirmed={confirmed} onConfirm={setConfirmed} />,
            () => <StepPreview compiled={compileScenario(clean, clean.translations[clean.lang], clean.lang, TEMPLATES)} auto={review.publishable} manual={confirmed.length === MANUAL.length} />][step]()}
          <ErrorLine message={errMsg} />
          <WizardNav step={step} busy={busy} canPublish={canPublish} onPrev={() => setStep(step - 1)} onNext={() => setStep(step + 1)} onSaveDraft={saveDraft} onPublish={publish} />
        </div>
      </div>
    </AppShell>
  );
}

/** 왼쪽 단계 내비 7개. ≤640px 번호 원만 보이므로 버튼마다 aria-label = 단계 이름. */
function WizardSteps({ current, onSelect }: { current: number; onSelect: (i: number) => void }) {
  const t = useT();
  return (
    <nav className="steps" aria-label={t('stepsAria')}>
      {STEPS.map((k, i) => (
        <button key={k} type="button" aria-label={t(k)} aria-current={i === current ? 'step' : undefined} className={i < current ? 'done' : undefined} onClick={() => onSelect(i)}>
          <span className="n" aria-hidden="true">{i + 1}</span><span className="lbl">{t(k)}</span>
        </button>
      ))}
    </nav>
  );
}

/** 이전 · 초안 저장 · 다음, 7단계에서만 게시(canPublish). */
function WizardNav({ step, busy, canPublish, onPrev, onNext, onSaveDraft, onPublish }: { step: number; busy: boolean; canPublish: boolean; onPrev: () => void; onNext: () => void; onSaveDraft: () => void; onPublish: () => void }) {
  const t = useT(), last = step === STEPS.length - 1;
  return (
    <div className="wiz-nav">
      <Button onClick={onPrev} disabled={step === 0}>{t('prev')}</Button>
      <div className="head-tools">
        <Button onClick={onSaveDraft} disabled={busy}>{t('saveDraft')}</Button>
        {last ? <Button variant="primary" onClick={onPublish} disabled={busy || !canPublish}>{t('publishBtn')}</Button> : <Button variant="primary" onClick={onNext}>{t('next')}</Button>}
      </div>
    </div>
  );
}
