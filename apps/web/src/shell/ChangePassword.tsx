import { useState } from 'react';
import { useI18n } from '../core/i18n';
import { useErrorText } from '../core/hooks';
import { api } from '../core/api';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { useToast } from '../ui/Toast';

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post('/auth/password', { current, next });
      toast.success(t('auth.passwordChanged'));
      setCurrent('');
      setNext('');
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('shell.changePassword')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!current || next.length < 8}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('auth.currentPassword')}>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label={t('auth.newPassword')} hint={t('setup.adminPasswordHint')} error={err}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
    </Dialog>
  );
}
