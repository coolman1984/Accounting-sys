import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { useErrorText } from '../../core/hooks';
import { Button } from '../../ui/Button';
import { Field, Input } from '../../ui/Field';
import { DecorLines, LangToggle, Logo, ThemeToggle } from '../../ui/Brand';

export function AuthFrame({ children, title, text }: { children: React.ReactNode; title: string; text: string }) {
  const { info } = useSession();
  return (
    <div className="auth">
      <DecorLines />
      <div className="auth-top">
        <Logo company={info?.companyName} />
        <div className="spacer" />
        <ThemeToggle />
        <LangToggle />
      </div>
      <div className="auth-hero">
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      {children}
    </div>
  );
}

export function LoginPage() {
  const { t } = useI18n();
  const { login } = useSession();
  const errText = useErrorText();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await login(username, password);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={t('auth.heroTitle')} text={t('auth.heroText')}>
      <form className="auth-card" onSubmit={submit}>
        <h2 style={{ fontSize: 20 }}>{t('auth.loginTitle')}</h2>
        <p className="muted" style={{ marginTop: 6, marginBottom: 20, fontSize: 13.5 }}>
          {t('auth.loginSubtitle')}
        </p>
        <div className="stack">
          <Field label={t('auth.username')}>
            <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label={t('auth.password')} error={err}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button variant="primary" size="lg" type="submit" loading={busy} disabled={!username || !password} style={{ width: '100%', marginTop: 6 }}>
            {t('auth.signIn')} <ArrowRight className="flip-rtl" />
          </Button>
        </div>
      </form>
      <p className="auth-foot">{t('auth.footer')}</p>
    </AuthFrame>
  );
}
