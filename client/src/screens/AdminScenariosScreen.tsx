import { useEffect, useState } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { CompiledPrompt } from '../components/CompiledPrompt.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Modal } from '../components/Modal.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { ScenarioCard } from '../components/ScenarioCard.tsx';
import { WorkflowStrip } from '../components/WorkflowStrip.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

type Summary = z.infer<typeof S.ScenarioSummary>;

/** 시나리오 목록(I-43): 워크플로 5단계 + 시나리오 카드 + "프롬프트 보기" 모달(저장본을 getScenarioPrompt 로, F-31). */
export function AdminScenariosScreen() {
  const t = useT(), me = useMe();
  const [list, setList] = useState<Summary[]>(), [err, setErr] = useState<unknown>();
  const [viewing, setViewing] = useState<Summary>(), [compiled, setCompiled] = useState<z.infer<typeof S.Compiled>>(), [promptErr, setPromptErr] = useState<unknown>();
  useEffect(() => { adminApi.listScenarios().then(setList, setErr); }, []);
  const view = (s: Summary) => {
    setViewing(s); setCompiled(undefined); setPromptErr(undefined);
    adminApi.getScenarioPrompt(s.id).then(setCompiled, setPromptErr);
  };
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <WorkflowStrip />
      <PageHead eyebrow={t('adminEyebrow')} title={t('listTitle')} lead={t('listLead')} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {list?.length === 0 && <p className="muted">{t('noScenarios')}</p>}
      <div className="cards">{list?.map(s => <ScenarioCard key={s.id} s={s} onViewPrompt={() => view(s)} />)}</div>
      <Modal open={!!viewing} title={t('promptTitle', viewing?.name)} onClose={() => setViewing(undefined)} actions={<Button onClick={() => setViewing(undefined)}>{t('close')}</Button>}>
        {promptErr !== undefined && <ErrorLine message={errorText(t, promptErr)} />}
        {compiled && <CompiledPrompt compiled={compiled} />}
      </Modal>
    </AppShell>
  );
}
