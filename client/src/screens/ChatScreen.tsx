// 대화 화면(C-12, I-50·I-51). 관리자 대화 테스트(`/admin/scenarios/:id/test`)와 예비교사 대화가 같은 화면을 쓴다.
// 진입: ?session= 이 있으면 그 세션(새로고침), 없으면 진행 중 세션 복구, 그것도 없으면 시작. 관리자는 그 직후 getAdminSession 1회로 패널을 채운다.
// 예비교사가 진행 중 세션과 다른 학생을 고르면 종료 안내만 그린다(세션은 사용자당 하나, session_active).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { ApiError, type AdminApi, type Api } from '../api/index.ts';
import { adminApi, teacherApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { ChatHeader, ClassificationBlock, Composer, Message, MessageLog, ProblemBox, QuickChips, SystemLine, type Speaker } from '../components/Chat.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { InternalPanel, triggerText } from '../components/InternalPanel.tsx';
import { Notice } from '../components/Notice.tsx';
import { SessionReport } from '../components/SessionReport.tsx';
import { errorText, useT, type T } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

type Detail = z.infer<typeof S.SessionDetail>;
type AdminState = z.infer<typeof S.AdminState>;
type Pub = z.infer<typeof S.ScenarioPublic>;
/** 화면에 필요한 시나리오 열. 관리자는 내부 설정(패널용)도 받는다. */
type View = Pick<Pub, 'name' | 'description' | 'problem' | 'student_prefix' | 'mentor_prefix' | 'classification'> & { lang: 'ko' | 'en'; internal?: z.infer<typeof S.Internal> };
/** 지금 흐르는 한 턴(아직 기록 전): 낙관적 예비교사 말풍선 + 받은 이벤트. */
interface Live { text: string; cls?: { leverage: string; object: string | null }; student?: string; mentor?: string }

const narrowQuery = '(max-width:900px)';
const useNarrow = () => useSyncExternalStore(cb => { const m = matchMedia(narrowQuery); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); }, () => matchMedia(narrowQuery).matches);

async function loadView(isAdminTest: boolean, scenarioId: string, lang: 'ko' | 'en'): Promise<View> {
  if (isAdminTest) { const s = await adminApi.getScenario(scenarioId); return { ...s, ...s.translations[lang], lang }; }
  const s = (await teacherApi.getPractice()).scenarios.find(x => x.id === scenarioId);
  if (!s) throw new ApiError(404, { error: { code: 'not_found', message: 'scenario not found' } });
  return s;
}

export function ChatScreen({ isAdminTest }: { isAdminTest: boolean }) {
  const t = useT(), me = useMe(), navigate = useNavigate(), narrow = useNarrow();
  const api: Api | AdminApi = isAdminTest ? adminApi : teacherApi;
  const { id: scenarioId = '' } = useParams(), [params, setParams] = useSearchParams(), [sid0] = useState(() => params.get('session'));
  const [detail, setDetail] = useState<Detail>(), [view, setView] = useState<View>(), [state, setState] = useState<AdminState>();
  const [live, setLive] = useState<Live | null>(null), [busy, setBusy] = useState(false), [draft, setDraft] = useState('');
  const [err, setErr] = useState<((t: T) => string) | null>(null), [loadErr, setLoadErr] = useState<unknown>(), [showCls, setShowCls] = useState(false);
  const [activeElsewhere, setActiveElsewhere] = useState<string>();   // 진행 중 세션의 시나리오 id
  const inputRef = useRef<HTMLInputElement>(null), refocus = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // StrictMode 이중 실행·다른 탭: 시작이 409 session_active 면 그 세션을 이어 쓴다.
      const start = () => api.startSession({ scenario_id: scenarioId }).catch(e => {
        if (e instanceof ApiError && e.code === 'session_active') return api.getSession((e.body.error.details as { session_id: string }).session_id);
        throw e;
      });
      const d = sid0 ? await api.getSession(sid0) : (await api.getCurrentSession()) ?? await start();
      if (!isAdminTest && !sid0 && d.session.scenario_id !== scenarioId) { if (alive) setActiveElsewhere(d.session.scenario_id); return; }
      const v = await loadView(isAdminTest, d.session.scenario_id, d.session.lang);
      const st = isAdminTest ? (await adminApi.getAdminSession(d.session.id)).state : undefined;
      if (!alive) return;
      setDetail(d); setView(v); setState(st);
      if (!sid0) setParams({ session: d.session.id }, { replace: true });
    })().catch(e => alive && setLoadErr(e));
    return () => { alive = false; };
  }, [api, isAdminTest, scenarioId, sid0, setParams]);

  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; inputRef.current?.focus(); } }, [busy]);

  const sid = detail?.session.id ?? '';
  const refetch = useCallback(async () => setDetail(await api.getSession(sid)), [api, sid]);
  /** 이 턴은 기록되지 않았다: 말풍선을 거두고 문장을 입력란에 돌려놓는다(I-51). */
  const restore = (text: string, msg: (t: T) => string) => { setLive(null); setDraft(text); setErr(() => msg); refocus.current = true; };

  async function send(text: string) {
    if (!detail || busy) return;
    const lastSeq = detail.turns.at(-1)?.seq ?? 0;
    setErr(null); setDraft(''); setBusy(true); setLive({ text });
    let done: Extract<z.infer<typeof S.AdminSseEvent>, { type: 'done' }> | undefined, failed = false;
    try {
      for await (const ev of api.sendTurn(sid, { text })) {
        if (ev.type === 'classification') setLive(l => l && { ...l, cls: { leverage: ev.leverage, object: ev.object } });
        else if (ev.type === 'student' || ev.type === 'mentor') setLive(l => l && { ...l, [ev.type]: ev.text });
        else if (ev.type === 'state') setState({ mis: ev.mis, counts: ev.counts, goal_reached: ev.goal_reached, last_trigger: ev.last_trigger });
        else if (ev.type === 'error') { failed = true; restore(text, t => t('turnFailed')); }   // 자동 재시도 없음, retryable 미사용
        else if (ev.type === 'done') done = ev;
      }
      if (failed) return;
      if (!done) {   // done 없이 끊김: 서버 기록과 맞춘다
        const d = await api.getSession(sid), last = d.turns.filter(x => x.speaker === 'teacher').at(-1);
        setDetail(d);
        if (d.turns.length > detail.turns.length && last?.text === text) setLive(null); else restore(text, t => t('turnFailed'));
      } else if (done.ended || done.turns[0]?.seq !== lastSeq + 1) { setLive(null); await refetch(); }   // 종료 또는 seq 불연속 → 전체 재조회
      else {
        const turns = done.turns;
        setLive(null);
        setDetail(d => d && { ...d, turns: [...d.turns, ...turns], session: { ...d.session, turn_count: d.session.turn_count + 1 } });
      }
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      if (code === 'turn_in_progress') { restore(text, t => t('turnBusy')); await refetch(); }
      else if (code === 'session_ended' || code === 'turn_limit_reached') { setLive(null); setDraft(text); await refetch(); }
      else if (code) restore(text, t => errorText(t, e));
      else { const d = await api.getSession(sid).catch(() => undefined); if (d) setDetail(d); restore(text, t => t('turnFailed')); }   // 스트림 중 끊김
    } finally { setBusy(false); }
  }

  async function end() {
    if (busy) return;
    setErr(null); setBusy(true);
    try { await api.endSession(sid); } catch (e) { if (!(e instanceof ApiError && e.code === 'session_ended')) setErr(() => (t: T) => e instanceof ApiError && e.code === 'turn_in_progress' ? t('turnBusy') : errorText(t, e)); }
    finally { await refetch().catch(() => {}); setBusy(false); }
  }

  const account = <AccountMenu kind={isAdminTest ? 'admin' : 'teacher'} nickname={me.nickname} />;
  if (activeElsewhere) return (
    <AppShell account={account}>
      <Notice tone="warn">{t('err.session_active')} {t('endFirst')}</Notice>
      <div className="head-tools">
        <Button variant="primary" onClick={() => { setActiveElsewhere(undefined); navigate(`/practice/${activeElsewhere}`); }}>{t('toActive')}</Button>
        <Button onClick={() => navigate('/practice')}>{t('otherStudent')}</Button>
      </div>
    </AppShell>
  );
  if (!detail || !view) return <AppShell account={account}>{loadErr !== undefined && <ErrorLine message={errorText(t, loadErr)} />}</AppShell>;

  const ended = !!detail.session.ended_at, atLimit = !ended && detail.session.turn_count >= detail.turn_limit, locked = busy || ended || atLimit;
  const hasCls = view.classification.leverage.length > 0;
  const who = (sp: Speaker) => sp === 'teacher' ? { avatar: '✏️', name: t('me') } : sp === 'student' ? { avatar: view.student_prefix, name: `${view.student_prefix} ${view.name}` } : { avatar: view.mentor_prefix, name: `${view.mentor_prefix} ${t('mentor')}` };
  const msg = (key: string | number, sp: Speaker, text: string, cls?: { leverage: string | null; object: string | null }) => (
    <Message key={key} speaker={sp} text={text} {...who(sp)}>
      {cls?.leverage != null && <ClassificationBlock leverage={cls.leverage} object={cls.object} show={showCls} />}
    </Message>
  );
  const panel = isAdminTest && state && view.internal && (
    <InternalPanel state={state} leverage={view.classification.leverage} misconceptions={view.internal.misconceptions.map(m => m.text)} goal={view.internal.goal} turns={detail.session.turn_count} />
  );

  return (
    <AppShell account={account}>
      <div className={isAdminTest ? 'chat-grid' : undefined}>
        {panel && narrow && <details className="rail-d"><summary>{t('railSummary', triggerText(t, state!.last_trigger))}</summary>{panel}</details>}
        <div className="chat">
          <ChatHeader avatar={view.student_prefix} name={view.name} description={view.description} showCls={hasCls ? showCls : null} onShowCls={setShowCls}
            onEnd={end} endDisabled={ended || busy} endPrimary={atLimit} onBack={() => navigate(isAdminTest ? '/admin/scenarios' : '/practice')} />
          <ProblemBox problem={view.problem} />
          <MessageLog size={detail.turns.length + (live ? 3 : 0) + (ended ? 1 : 0)}>
            <SystemLine>{t('sessStart')}</SystemLine>
            {detail.turns.map(x => msg(x.seq, x.speaker, x.text, x))}
            {live && <>
              {msg('live-t', 'teacher', live.text, live.cls)}
              {live.student !== undefined && msg('live-s', 'student', live.student)}
              {live.mentor !== undefined && msg('live-m', 'mentor', live.mentor)}
            </>}
            {ended && detail.report && <><SessionReport report={detail.report} /><SystemLine>{t('endCls')}</SystemLine></>}
            {ended && !detail.report && <SystemLine>{t('endNoCls')}</SystemLine>}
            {atLimit && <SystemLine>{t('turnLimit', String(detail.turn_limit))}</SystemLine>}
          </MessageLog>
          <ErrorLine message={err?.(t)} />
          <QuickChips lang={view.lang} disabled={locked} onPick={c => { setDraft(c); inputRef.current?.focus(); }} />
          <Composer lang={view.lang} value={draft} onChange={setDraft} onSend={send} disabled={locked} inputRef={inputRef} />
        </div>
        {panel && !narrow && panel}
      </div>
    </AppShell>
  );
}
