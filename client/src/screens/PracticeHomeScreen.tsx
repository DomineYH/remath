import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { teacherApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Notice } from '../components/Notice.tsx';
import { Pill } from '../components/Pill.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

type Home = z.infer<typeof S.PracticeHome>;

/** 학생 선택(I-49): 인디고 배너 + 내 그룹에 할당된 게시 시나리오 카드. 그룹 0 → noGroup, 할당 0 → noScenario. */
export function PracticeHomeScreen() {
  const t = useT(), me = useMe(), navigate = useNavigate();
  const [home, setHome] = useState<Home>(), [err, setErr] = useState<unknown>();
  useEffect(() => { teacherApi.getPractice().then(setHome, setErr); }, []);
  const groupName = (id: string) => home?.groups.find(g => g.id === id)?.name ?? '';
  return (
    <AppShell account={<AccountMenu kind="teacher" nickname={me.nickname} />}>
      <PracticeBanner nickname={me.nickname} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {home && home.scenarios.length === 0 && <NoAccessNotice kind={home.groups.length ? 'noScenario' : 'noGroup'} nickname={me.nickname} />}
      <div className="pick">
        {home?.scenarios.map(s => <ScenarioPickCard key={s.id} s={s} via={s.group_ids.map(groupName).join(', ')} onPick={() => navigate(`/practice/${s.id}`)} />)}
      </div>
    </AppShell>
  );
}

function PracticeBanner({ nickname }: { nickname: string }) {
  const t = useT();
  return (
    <div className="band">
      <p className="eyebrow">{t('pickEyebrow')}</p>
      <h2>{t('pickTitle')}</h2>
      <p>{t('pickLead')}</p>
      <p className="hello">{t('hello', nickname)}<Link to="/practice/history">{t('myHistory')}</Link></p>
    </div>
  );
}

/** 공개 시나리오 뷰 열만: 이모지·이름·학년·소개·챗봇 언어·분석 여부(분류 기준 유무)·via 그룹. */
function ScenarioPickCard({ s, via, onPick }: { s: Home['scenarios'][number]; via: string; onPick: () => void }) {
  const t = useT(), analysed = s.classification.leverage.length > 0;
  return (
    <button type="button" onClick={onPick}>
      <Avatar emoji={s.student_prefix} />
      <b>{s.name}</b>
      <small>{s.grade}</small>
      <small>{s.description}</small>
      <span className="tags">
        <Pill tone="lang">{s.lang === 'en' ? 'English' : '한국어'}</Pill>
        <Pill tone={analysed ? 'pub' : undefined}>{t(analysed ? 'anaOn' : 'anaOff')}</Pill>
        <Pill>{t('viaGroup', via)}</Pill>
      </span>
    </button>
  );
}

function NoAccessNotice({ kind, nickname }: { kind: 'noGroup' | 'noScenario'; nickname: string }) {
  const t = useT();
  return <Notice tone="warn">{t(kind === 'noGroup' ? 'noAccessNoGroup' : 'noAccessNoScen', nickname)}</Notice>;
}
