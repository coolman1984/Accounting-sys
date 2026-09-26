import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';
import { useI18n } from '../core/i18n';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Focus the first field for fast keyboard entry.
    requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button.btn-primary');
      first?.focus();
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="dialog-header">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" iconOnly icon={<X />} onClick={onClose} style={{ marginInlineStart: 'auto' }} aria-label="Close" />
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ confirm

interface ConfirmOpts {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: ReactNode;
  danger?: boolean;
  /** Optional date field (e.g. reversal date). */
  withDate?: { label: ReactNode; value: string };
}

type Resolver = (v: { ok: boolean; date?: string }) => void;
const ConfirmContext = createContext<(o: ConfirmOpts) => Promise<{ ok: boolean; date?: string }>>(() => Promise.resolve({ ok: false }));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ opts: ConfirmOpts; resolve: Resolver } | null>(null);
  const [date, setDate] = useState('');
  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<{ ok: boolean; date?: string }>((resolve) => {
        setDate(opts.withDate?.value ?? '');
        setState({ opts, resolve });
      }),
    [],
  );
  const close = (ok: boolean) => {
    state?.resolve({ ok, date: state.opts.withDate ? date : undefined });
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        title={state?.opts.title}
        footer={
          <>
            <Button onClick={() => close(false)}>{t('common.cancel')}</Button>
            <Button variant={state?.opts.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
              {state?.opts.confirmLabel ?? t('common.confirm')}
            </Button>
          </>
        }
      >
        {state?.opts.body && <p className="muted">{state.opts.body}</p>}
        {state?.opts.withDate && (
          <div className="field" style={{ marginTop: 14 }}>
            <label>{state.opts.withDate.label}</label>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
