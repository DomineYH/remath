// 그룹 탭(I-46): GroupCard + GroupEditModal(이름·구성원·시나리오, 전체 치환) + DeleteGroupModal.
import { useCallback, useEffect, useId, useState } from 'react';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { Card } from '../components/Card.tsx';
import { CheckList } from '../components/CheckList.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Field } from '../components/Field.tsx';
import { Modal } from '../components/Modal.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Pill } from '../components/Pill.tsx';
import { toast } from '../components/Toast.tsx';
import { errorText, useT } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';

type Group = z.infer<typeof S.Group>;
type User = z.infer<typeof S.UserRow>;
type Summary = z.infer<typeof S.ScenarioSummary>;

export function AdminGroupsScreen() {
  const t = useT(), me = useMe();
  const [groups, setGroups] = useState<Group[]>(), [users, setUsers] = useState<User[]>([]), [scenarios, setScenarios] = useState<Summary[]>([]), [err, setErr] = useState<unknown>();
  const [editing, setEditing] = useState<Group | 'new'>(), [delFor, setDelFor] = useState<Group>(), [editN, setEditN] = useState(0);
  // 열 때만 key 를 바꿔 폼을 새로 채운다. 닫을 때는 그대로 두어 <dialog> 가 포커스를 되돌린다.
  const edit = (g: Group | 'new') => { setEditN(n => n + 1); setEditing(g); };
  const load = useCallback(() => Promise.all([adminApi.listGroups(), adminApi.listUsers(), adminApi.listScenarios()])
    .then(([g, u, s]) => { setGroups(g); setUsers(u); setScenarios(s); }, setErr), []);
  useEffect(() => { load(); }, [load]);
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <PageHead eyebrow={t('groupsEyebrow')} title={t('groupsTitle')} lead={t('groupsLead')} actions={<Button variant="primary" onClick={() => edit('new')}>{t('addGroup')}</Button>} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {groups?.length === 0 && <p className="muted">{t('noGroupsYet')}</p>}
      <div className="cards">{groups?.map(g => <GroupCard key={g.id} g={g} onEdit={() => edit(g)} onDelete={() => setDelFor(g)} />)}</div>
      <GroupEditModal key={editN} open={!!editing} group={editing === 'new' ? undefined : editing} users={users} scenarios={scenarios} onClose={() => setEditing(undefined)} onDone={load} />
      <DeleteGroupModal group={delFor} onClose={() => setDelFor(undefined)} onDone={load} />
    </AppShell>
  );
}

/** 구성원 필 + 할당 시나리오 필(lang). 시나리오가 없으면 "이용 불가" 경고 필. */
function GroupCard({ g, onEdit, onDelete }: { g: Group; onEdit: () => void; onDelete: () => void }) {
  const t = useT();
  return (
    <Card title={g.name} sub={t('members', String(g.members.length))}
      actions={<><Button size="sm" onClick={onEdit}>{t('edit')}</Button><Button size="sm" variant="danger" onClick={onDelete}>{t('del')}</Button></>}>
      <div className="gsec"><span className="eyebrow">{t('fMembers')}</span>
        <div className="pills">{g.members.length ? g.members.map(m => <Pill key={m.id}>{m.nickname}</Pill>) : <span className="muted">{t('noMembers')}</span>}</div></div>
      <div className="gsec"><span className="eyebrow">{t('scenAssigned')}</span>
        <div className="pills">{g.scenarios.length ? g.scenarios.map(s => <Pill key={s.id} tone="lang">{s.name}</Pill>) : <Pill tone="draft">{t('noScen')}</Pill>}</div></div>
    </Card>
  );
}

/** 새 그룹 또는 편집. 저장은 이름·구성원·시나리오 전체를 보낸다(PUT 전체 치환). 초안 시나리오에는 draft 배지. */
function GroupEditModal({ open, group, users, scenarios, onClose, onDone }: { open: boolean; group?: Group; users: User[]; scenarios: Summary[]; onClose: () => void; onDone: () => void }) {
  const t = useT(), id = useId();
  const [name, setName] = useState(group?.name ?? ''), [err, setErr] = useState('');
  const [members, setMembers] = useState(group?.members.map(m => m.id) ?? []), [scen, setScen] = useState(group?.scenarios.map(s => s.id) ?? []);
  const save = async () => {
    if (!name.trim()) return setErr(t('errGName'));
    const body = { name: name.trim(), member_ids: members, scenario_ids: scen };
    try { await (group ? adminApi.updateGroup(group.id, body) : adminApi.createGroup(body)); onClose(); onDone(); toast(t('groupSaved')); } catch (e) { setErr(errorText(t, e)); }
  };
  return (
    <Modal open={open} title={group ? t('mEditGroup', group.name) : t('mNewGroup')} onClose={onClose}
      actions={<><Button onClick={onClose}>{t('cancel')}</Button><Button variant="primary" onClick={save}>{t('save')}</Button></>}>
      <Field label={t('fGName')} htmlFor={`${id}-name`}>
        <input id={`${id}-name`} autoComplete="off" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <CheckList legend={t('fMembers')} items={users.map(u => ({ id: u.id, label: u.nickname }))} value={members} onChange={setMembers} empty={t('noUsersYet')} />
      <CheckList legend={t('fScen')} hint={t('fScenH')} value={scen} onChange={setScen} empty={t('noScenarios')}
        items={scenarios.map(s => ({ id: s.id, label: <>{s.student_prefix} {s.name} {s.status === 'draft' && <Pill tone="draft">{t('draft')}</Pill>}</> }))} />
      <ErrorLine message={err} />
    </Modal>
  );
}

function DeleteGroupModal({ group, onClose, onDone }: { group?: Group; onClose: () => void; onDone: () => void }) {
  const t = useT(), [err, setErr] = useState('');
  const close = () => { setErr(''); onClose(); };
  const confirm = async () => {
    if (!group) return;
    try { await adminApi.deleteGroup(group.id); close(); onDone(); toast(t('groupDeleted')); } catch (e) { setErr(errorText(t, e)); }
  };
  return <ConfirmModal open={!!group} title={t('mDelGroup', group?.name)} body={t('delGroupBody')} confirmLabel={t('delConfirm')} onConfirm={confirm} onClose={close} error={err} />;
}
