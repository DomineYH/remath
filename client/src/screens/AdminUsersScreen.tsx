// 사용자 탭(I-45): UsersTable 7열 + 사용자 추가·비밀번호 재설정·삭제 모달. 사용자 CSV 는 대화 기록 탭(#27)과 함께 연다.
import { useCallback, useEffect, useId, useState } from 'react';
import { Password } from '@remath/shared';
import type * as S from '@remath/shared';
import type { z } from 'zod';
import { adminApi } from '../apis.ts';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { AdminSubnav } from '../components/AdminSubnav.tsx';
import { AppShell } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { CheckList } from '../components/CheckList.tsx';
import { ConfirmModal } from '../components/ConfirmModal.tsx';
import { DataTable } from '../components/DataTable.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Field } from '../components/Field.tsx';
import { Modal } from '../components/Modal.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { PasswordFields, type PasswordValue } from '../components/PasswordFields.tsx';
import { Pill } from '../components/Pill.tsx';
import { toast } from '../components/Toast.tsx';
import { errorText, useT, type T } from '../i18n/index.tsx';
import { useMe } from '../session.tsx';
import { nickError } from './LoginScreen.tsx';

type User = z.infer<typeof S.UserRow>;
type Group = z.infer<typeof S.Group>;
/** 비밀번호 규칙·확인 일치 검사. 통과하면 빈 문자열. */
const pwError = (t: T, v: PasswordValue) => !Password.safeParse(v.next).success ? t('errPw') : v.next !== v.confirm ? t('errPw2') : '';

export function AdminUsersScreen() {
  const t = useT(), me = useMe();
  const [users, setUsers] = useState<User[]>(), [groups, setGroups] = useState<Group[]>([]), [err, setErr] = useState<unknown>();
  const [adding, setAdding] = useState(false), [pwFor, setPwFor] = useState<User>(), [delFor, setDelFor] = useState<User>();
  const load = useCallback(() => Promise.all([adminApi.listUsers(), adminApi.listGroups()]).then(([u, g]) => { setUsers(u); setGroups(g); }, setErr), []);
  useEffect(() => { load(); }, [load]);

  const rows = (users ?? []).map(u => ({
    key: u.id, cells: [
      <b>{u.nickname}</b>,
      u.groups.length ? u.groups.map(g => <Pill key={g.id}>{g.name}</Pill>) : <Pill tone="draft">{t('noGroups')}</Pill>,
      u.scenario_count ? t('scenN', String(u.scenario_count)) : <Pill tone="draft">{t('noAccessShort')}</Pill>,
      <span className="mono">{u.session_count}</span>,
      <span className="mono">{u.created_at.slice(0, 10)}</span>,
      <span className="mono">{u.pw_updated_at.slice(0, 10)}</span>,
      <div className="acts-cell">
        <Button size="sm" disabled title={t('csvLater')}>CSV</Button>
        <Button size="sm" onClick={() => setPwFor(u)} aria-label={`${t('pwBtn')} · ${u.nickname}`}>{t('pwBtn')}</Button>
        <Button size="sm" variant="danger" onClick={() => setDelFor(u)} aria-label={`${t('del')} · ${u.nickname}`}>{t('del')}</Button>
      </div>,
    ],
  }));
  return (
    <AppShell account={<AccountMenu kind="admin" nickname={me.nickname} />} subnav={<AdminSubnav />}>
      <PageHead eyebrow={t('usersEyebrow')} title={t('usersTitle')} lead={t('usersLead')} actions={<Button variant="primary" onClick={() => setAdding(true)}>{t('addUser')}</Button>} />
      {err !== undefined && <ErrorLine message={errorText(t, err)} />}
      {users && <DataTable wide label={t('usersTitle')} empty={t('noUsersYet')} rows={rows}
        head={[t('thNick'), t('thGroups'), t('thAccess'), t('thConv'), t('thCreated'), t('thPw'), '']} />}
      <AddUserModal open={adding} groups={groups} onClose={() => setAdding(false)} onDone={load} />
      <ChangePasswordModal user={pwFor} onClose={() => setPwFor(undefined)} onDone={load} />
      <DeleteUserModal user={delFor} onClose={() => setDelFor(undefined)} onDone={load} />
    </AppShell>
  );
}

/** 닉네임 + 비밀번호(규칙 실시간) + 소속 그룹. 그룹 소속은 createUser 뒤 그룹 PUT(전체 치환)으로 넣는다. */
function AddUserModal({ open, groups, onClose, onDone }: { open: boolean; groups: Group[]; onClose: () => void; onDone: () => void }) {
  const t = useT(), id = useId();
  const [nick, setNick] = useState(''), [pw, setPw] = useState<PasswordValue>({ next: '', confirm: '' }), [sel, setSel] = useState<string[]>([]), [err, setErr] = useState('');
  const close = () => { setNick(''); setPw({ next: '', confirm: '' }); setSel([]); setErr(''); onClose(); };
  const save = async () => {
    const nickname = nick.trim(), e = nickError(t, nickname) || pwError(t, pw);
    if (e) return setErr(e);
    try {
      const u = await adminApi.createUser({ nickname, password: pw.next });
      for (const g of groups.filter(g => sel.includes(g.id))) await adminApi.updateGroup(g.id, { name: g.name, member_ids: [...g.members.map(m => m.id), u.id], scenario_ids: g.scenarios.map(s => s.id) });
      close(); onDone(); toast(t('userAdded', nickname));
    } catch (e) { setErr(errorText(t, e)); onDone(); }
  };
  return (
    <Modal open={open} title={t('mAddUser')} onClose={close} actions={<><Button onClick={close}>{t('cancel')}</Button><Button variant="primary" onClick={save}>{t('add')}</Button></>}>
      <Field label={t('nick')} htmlFor={`${id}-nick`} hint={t('nickH')}>
        <input id={`${id}-nick`} autoComplete="off" maxLength={16} spellCheck={false} value={nick} onChange={e => setNick(e.target.value)} />
      </Field>
      <PasswordFields onChange={setPw} />
      <CheckList legend={t('fGroups')} items={groups.map(g => ({ id: g.id, label: g.name }))} value={sel} onChange={setSel} empty={t('noGroupsYet')} />
      <ErrorLine message={err} />
    </Modal>
  );
}

/** 관리자가 사용자 비밀번호를 재설정(현재 비밀번호 없음). 서버는 그 사용자의 로그인을 모두 끝낸다. */
function ChangePasswordModal({ user, onClose, onDone }: { user?: User; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [pw, setPw] = useState<PasswordValue>({ next: '', confirm: '' }), [err, setErr] = useState('');
  const close = () => { setPw({ next: '', confirm: '' }); setErr(''); onClose(); };
  const save = async () => {
    const e = pwError(t, pw);
    if (e || !user) return setErr(e);
    try { await adminApi.resetUserPassword(user.id, { password: pw.next }); close(); onDone(); toast(t('pwChanged', user.nickname)); } catch (e) { setErr(errorText(t, e)); }
  };
  return (
    <Modal open={!!user} title={t('mPw', user?.nickname)} onClose={close} actions={<><Button onClick={close}>{t('cancel')}</Button><Button variant="primary" onClick={save}>{t('save')}</Button></>}>
      <PasswordFields onChange={setPw} />
      <ErrorLine message={err} />
    </Modal>
  );
}

/** 대화 기록 건수를 보여 주고, 건수가 있으면 "CSV 먼저 내려받기"(대화 기록 탭과 함께 열림). */
function DeleteUserModal({ user, onClose, onDone }: { user?: User; onClose: () => void; onDone: () => void }) {
  const t = useT(), [err, setErr] = useState('');
  const close = () => { setErr(''); onClose(); };
  const confirm = async () => {
    if (!user) return;
    try { await adminApi.deleteUser(user.id); close(); onDone(); toast(t('userDeleted', user.nickname)); } catch (e) { setErr(errorText(t, e)); }
  };
  return (
    <ConfirmModal open={!!user} title={t('mDelUser', user?.nickname)} body={t('delUserBody', String(user?.session_count ?? 0))} confirmLabel={t('delConfirm')}
      onConfirm={confirm} onClose={close} error={err}
      extraAction={user?.session_count ? <Button disabled title={t('csvLater')}>{t('dlFirst')}</Button> : undefined} />
  );
}
