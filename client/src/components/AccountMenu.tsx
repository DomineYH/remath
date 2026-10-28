import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Password } from '@remath/shared';
import { ApiError } from '../api/index.ts';
import { adminApi, teacherApi } from '../apis.ts';
import { errorText, useT } from '../i18n/index.tsx';
import { Button } from './Button.tsx';
import { ErrorLine } from './ErrorLine.tsx';
import { Modal } from './Modal.tsx';
import { PasswordFields, type PasswordValue } from './PasswordFields.tsx';
import { toast } from './Toast.tsx';
import { useDismiss } from './useDismiss.ts';

/** 닉네임 버튼 하나 + 드롭다운(비밀번호 변경·로그아웃). Esc·바깥 클릭으로 닫힌다(티켓 17 #3). */
export function AccountMenu({ kind, nickname }: { kind: 'teacher' | 'admin'; nickname: string }) {
  const t = useT(), navigate = useNavigate();
  const [open, setOpen] = useState(false), [pwOpen, setPwOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null);

  useDismiss(open, useCallback(() => setOpen(false), []), box, btn);

  const logout = async () => {
    setOpen(false);
    await (kind === 'admin' ? adminApi.adminLogout() : teacherApi.logout()).catch(() => {});
    toast(t('loggedOut'));
    navigate(kind === 'admin' ? '/admin' : '/', { replace: true });
  };

  return (
    <div className="acct" ref={box}>
      <button ref={btn} type="button" className="btn sm acct-name" aria-haspopup="menu" aria-expanded={open} aria-label={t('acctAria')} onClick={() => setOpen(o => !o)}>
        {kind === 'admin' ? `🔑 ${t('adminAcct')}` : `✏️ ${nickname}`}
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setPwOpen(true); }}>{t('changePw')}</button>
          <button type="button" role="menuitem" onClick={logout}>{t('logout')}</button>
        </div>
      )}
      <ChangePasswordModal kind={kind} open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

function ChangePasswordModal({ kind, open, onClose }: { kind: 'teacher' | 'admin'; open: boolean; onClose: () => void }) {
  const t = useT();
  const empty: PasswordValue = { current: '', next: '', confirm: '' };
  const [v, setV] = useState<PasswordValue>(empty), [err, setErr] = useState('');
  // Modal unmounts PasswordFields on close, so its inputs reopen empty; reset the copy here too so a reopened form submits what it shows.
  const close = () => { setV(empty); setErr(''); onClose(); };
  const save = async () => {
    if (!Password.safeParse(v.next).success) return setErr(t('errPw'));
    if (v.next !== v.confirm) return setErr(t('errPw2'));
    const body = { current: v.current ?? '', next: v.next };
    try {
      await (kind === 'admin' ? adminApi.adminChangePassword(body) : teacherApi.changePassword(body));
      close(); toast(t('selfPwDone'));
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'invalid_credentials' ? t('errCurPw') : errorText(t, e));
    }
  };
  return (
    <Modal open={open} title={t('mSelfPw')} onClose={close}
      actions={<><Button onClick={close}>{t('cancel')}</Button><Button variant="primary" onClick={save}>{t('save')}</Button></>}>
      <PasswordFields withCurrent onChange={setV} />
      <ErrorLine message={err} />
    </Modal>
  );
}
