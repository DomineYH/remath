import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { adminApi } from '../apis.ts';
import { AppShell } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Field } from '../components/Field.tsx';
import { useT } from '../i18n/index.tsx';
import { HOME } from '../session.tsx';

export function AdminLoginScreen() {
  const t = useT(), navigate = useNavigate(), id = useId();
  const [nickname, setNickname] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await adminApi.adminLogin({ nickname: nickname.trim(), password: pw });
      navigate(HOME.admin, { replace: true });
    } catch {
      setErr(t('errAdminFail'));   // 구분 없는 오류 1종
    } finally { setBusy(false); }
  };

  return (
    <AppShell>
      <div className="auth"><div className="auth-card">
        <p className="eyebrow">{t('aLoginEyebrow')}</p>
        <h2>{t('aLoginTitle')}</h2>
        <p className="lead">{t('aLoginLead')}</p>
        <form onSubmit={submit} noValidate>
          <Field label={t('aId')} htmlFor={`${id}-id`}>
            <input id={`${id}-id`} autoComplete="username" spellCheck={false} value={nickname} onChange={e => setNickname(e.target.value)} />
          </Field>
          <Field label={t('pw')} htmlFor={`${id}-pw`}>
            <input id={`${id}-pw`} type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
          </Field>
          <ErrorLine message={err} />
          <Button type="submit" variant="primary" wide disabled={busy}>{t('aLoginBtn')}</Button>
        </form>
        <Link className="authlink" to="/">{t('toUser')}</Link>
      </div></div>
    </AppShell>
  );
}
