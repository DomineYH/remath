import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Nickname, Password } from '@remath/shared';
import { ApiError } from '../api/index.ts';
import { teacherApi } from '../apis.ts';
import { AppShell } from '../components/AppShell.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorLine } from '../components/ErrorLine.tsx';
import { Field } from '../components/Field.tsx';
import { PasswordFields, type PasswordValue } from '../components/PasswordFields.tsx';
import { SegmentedToggle } from '../components/SegmentedToggle.tsx';
import { toast } from '../components/Toast.tsx';
import { errorText, useT, type T } from '../i18n/index.tsx';
import { HOME } from '../session.tsx';

/** 이메일·전화번호처럼 보이면(@, 숫자 7자리 연속) 개인정보 문구, 아니면 형식 문구. */
export const nickError = (t: T, v: string) => Nickname.safeParse(v).success ? '' : t(/@|\d{7}/.test(v) ? 'errNickPII' : 'errNick');

export function LoginScreen() {
  const t = useT(), navigate = useNavigate(), id = useId();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [nickname, setNickname] = useState(''), [pw, setPw] = useState(''), [pwv, setPwv] = useState<PasswordValue>({ next: '', confirm: '' });
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const up = mode === 'signup', nick = nickname.trim();
  const liveNickErr = up && nick.length >= 2 ? nickError(t, nick) : '';

  const switchMode = (m: 'login' | 'signup') => { setMode(m); setErr(''); setPwv({ next: '', confirm: '' }); setPw(''); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (up) {
      const ne = nickError(t, nick);
      if (ne) return setErr(ne);
      if (!Password.safeParse(pwv.next).success) return setErr(t('errPw'));
      if (pwv.next !== pwv.confirm) return setErr(t('errPw2'));
    }
    setBusy(true); setErr('');
    try {
      const me = up ? await teacherApi.signup({ nickname: nick, password: pwv.next }) : await teacherApi.login({ nickname: nick, password: pw });
      if (up) toast(t('welcome', me.nickname));
      navigate(HOME.teacher, { replace: true });
    } catch (e) {
      // 로그인에서는 400(형식)과 401 을 같은 문구로: 계정 존재 여부를 드러내지 않는다.
      setErr(!up && e instanceof ApiError && e.status === 400 ? t('err.invalid_credentials') : errorText(t, e));
    } finally { setBusy(false); }
  };

  return (
    <AppShell>
      <div className="auth"><div className="auth-card">
        <p className="eyebrow">{t('authTag')}</p>
        <h2>{t(up ? 'signupTitle' : 'loginTitle')}</h2>
        <p className="lead">{t(up ? 'signupLead' : 'loginLead')}</p>
        <SegmentedToggle className="auth-tabs" ariaLabel={t('authTabsAria')} value={mode} onChange={switchMode}
          options={[{ value: 'login', label: t('tabLogin') }, { value: 'signup', label: t('tabSignup') }]} />
        <form onSubmit={submit} noValidate>
          <Field label={t('nick')} htmlFor={`${id}-nick`} hint={up ? t('nickH') : undefined}>
            <input id={`${id}-nick`} autoComplete="username" maxLength={16} spellCheck={false} value={nickname} onChange={e => setNickname(e.target.value)} />
            <ErrorLine message={liveNickErr} />
          </Field>
          {up ? <PasswordFields key="signup" onChange={setPwv} /> : (
            <Field label={t('pw')} htmlFor={`${id}-pw`}>
              <input id={`${id}-pw`} type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
            </Field>
          )}
          <ErrorLine message={err} />
          <Button type="submit" variant="primary" wide disabled={busy}>{t(up ? 'signupBtn' : 'loginBtn')}</Button>
        </form>
        <div className="privacy">{t('noPII')}</div>
        <Link className="authlink" to="/admin">{t('toAdmin')}</Link>
      </div></div>
    </AppShell>
  );
}
