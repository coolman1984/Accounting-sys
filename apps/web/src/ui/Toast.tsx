import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck } from 'lucide-react';

interface Toast {
  id: number;
  kind: 'success' | 'error';
  title: string;
  msg?: string;
}

interface ToastApi {
  success(title: string, msg?: string): void;
  error(title: string, msg?: string): void;
}

const ToastContext = createContext<ToastApi>({ success: () => undefined, error: () => undefined });
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], title: string, msg?: string) => {
    const id = ++seq;
    setList((l) => [...l.slice(-3), { id, kind, title, msg }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), kind === 'error' ? 6500 : 3200);
  }, []);
  const [api] = useState<ToastApi>(() => ({
    success: (t, m) => push('success', t, m),
    error: (t, m) => push('error', t, m),
  }));
  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {list.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.kind === 'success' ? <CircleCheck /> : <CircleAlert />}
              <div>
                <div className="toast-title">{t.title}</div>
                {t.msg && <div className="toast-msg">{t.msg}</div>}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
