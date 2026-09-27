import { useState } from 'react';
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { useErrorText } from '../../core/hooks';
import { api } from '../../core/api';
import { Button } from '../../ui/Button';
import { Field, Input, Select } from '../../ui/Field';
import { AuthFrame } from './Login';
import { toggleApp } from '../../core/apps';
import { AppCard } from '../../ui/AppCard';

const CURRENCIES = [
  ['EGP', 2],
  ['SAR', 2],
  ['AED', 2],
  ['USD', 2],
  ['EUR', 2],
  ['KWD', 3],
  ['JOD', 3],
  ['BHD', 3],
  ['OMR', 3],
  ['QAR', 2],
  ['MAD', 2],
  ['GBP', 2],
] as const;

export function SetupPage() {
  const { t, locale } = useI18n();
  const { refresh, login, info } = useSession();
  const catalogue = (info?.apps ?? []).slice().sort((a, b) => a.order - b.order);
  // Everything on by default; the owner unticks what the company does not need.
  const [apps, setApps] = useState<Set<string>>(() => new Set(catalogue.filter((a) => !a.core).map((a) => a.id)));
  const errText = useErrorText();
  const year = new Date().getFullYear();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [f, setF] = useState({
    name: '',
    legalName: '',
    taxNumber: '',
    baseCurrency: 'EGP',
    moneyScale: 2,
    fiscalYearStart: `${year}-01-01`,
    chart: 'standard',
    vat: '14',
    displayName: '',
    username: 'admin',
    password: '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const LAST = 3;
  const canNext = [f.name.trim().length > 0, !!f.fiscalYearStart, true, f.displayName.trim() && f.username.trim().length >= 3 && f.password.length >= 8][step];

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const vat = f.vat.trim() === '' ? null : Math.round(Number(f.vat) * 100);
      await api.post('/setup', {
        company: {
          name: f.name,
          legalName: f.legalName || null,
          taxNumber: f.taxNumber || null,
          baseCurrency: f.baseCurrency,
          moneyScale: f.moneyScale,
        },
        fiscalYearStart: f.fiscalYearStart,
        admin: { username: f.username, displayName: f.displayName, password: f.password },
        locale,
        seedChartOfAccounts: f.chart === 'standard',
        vatRateBp: vat,
        apps: catalogue.length ? [...apps] : undefined,
      });
      await refresh();
      await login(f.username, f.password);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={t('setup.title')} text={t('setup.subtitle')}>
      <div className="auth-card wide">
        <div className="steps">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>
        <h2 style={{ fontSize: 19, marginBottom: 18 }}>{[t('setup.stepCompany'), t('setup.stepBooks'), t('setup.stepApps'), t('setup.stepAdmin')][step]}</h2>

        {step === 0 && (
          <div className="stack">
            <Field label={t('setup.companyName')}>
              <Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <div className="grid-2">
              <Field label={`${t('setup.legalName')} (${t('common.optional')})`}>
                <Input value={f.legalName} onChange={(e) => set('legalName', e.target.value)} />
              </Field>
              <Field label={`${t('common.taxNumber')} (${t('common.optional')})`}>
                <Input value={f.taxNumber} onChange={(e) => set('taxNumber', e.target.value)} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label={t('setup.baseCurrency')}>
                <Select
                  value={f.baseCurrency}
                  onChange={(e) => {
                    const c = CURRENCIES.find((x) => x[0] === e.target.value);
                    set('baseCurrency', e.target.value);
                    if (c) set('moneyScale', c[1]);
                  }}
                >
                  {CURRENCIES.map(([c]) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('setup.decimals')} hint={t('setup.decimalsHint')}>
                <Select value={f.moneyScale} onChange={(e) => set('moneyScale', Number(e.target.value))}>
                  {[0, 1, 2, 3].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="stack">
            <div className="grid-2">
              <Field label={t('setup.fiscalYearStart')}>
                <Input type="date" value={f.fiscalYearStart} onChange={(e) => set('fiscalYearStart', e.target.value)} />
              </Field>
              <Field label={t('setup.vat')} hint={t('setup.vatHint')}>
                <Input inputMode="decimal" value={f.vat} onChange={(e) => set('vat', e.target.value)} />
              </Field>
            </div>
            <Field label={t('setup.chart')}>
              <div className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                {(['standard', 'minimal'] as const).map((c) => (
                  <label key={c} className="card" style={{ padding: '12px 14px', display: 'flex', gap: 10, cursor: 'pointer', alignItems: 'center', borderColor: f.chart === c ? 'var(--primary)' : undefined }}>
                    <input type="radio" name="chart" checked={f.chart === c} onChange={() => set('chart', c)} style={{ accentColor: 'var(--primary)' }} />
                    <span>{t(c === 'standard' ? 'setup.chartStandard' : 'setup.chartMinimal')}</span>
                  </label>
                ))}
              </div>
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="stack" style={{ '--gap': '10px' } as React.CSSProperties}>
            <p className="muted" style={{ fontSize: 13.5, marginTop: -8 }}>
              {t('setup.appsHint')}
            </p>
            {catalogue.map((a) => (
              <AppCard key={a.id} app={a} compact on={a.core || apps.has(a.id)} onToggle={(v) => setApps(toggleApp(catalogue, apps, a.id, v))} />
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <Field label={t('setup.adminName')}>
              <Input autoFocus value={f.displayName} onChange={(e) => set('displayName', e.target.value)} />
            </Field>
            <div className="grid-2">
              <Field label={t('setup.adminUsername')}>
                <Input value={f.username} onChange={(e) => set('username', e.target.value)} autoComplete="username" />
              </Field>
              <Field label={t('setup.adminPassword')} hint={t('setup.adminPasswordHint')}>
                <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
              </Field>
            </div>
          </div>
        )}

        {err && (
          <p className="danger-text" style={{ marginTop: 14, fontSize: 13.5 }}>
            {err}
          </p>
        )}

        <div className="row" style={{ marginTop: 24 }}>
          {step > 0 && (
            <Button onClick={() => setStep(step - 1)} icon={<ArrowLeft className="flip-rtl" />}>
              {t('setup.back')}
            </Button>
          )}
          <div className="spacer" />
          {step < LAST ? (
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              {t('setup.next')} <ArrowRight className="flip-rtl" />
            </Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={!canNext} onClick={submit} icon={<Sparkles />}>
              {t('setup.finish')}
            </Button>
          )}
        </div>
      </div>
    </AuthFrame>
  );
}
