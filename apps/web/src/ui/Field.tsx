import { forwardRef, useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { formatMinor, parseDecimal, toEditable } from '../core/format';

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={'field ' + (className ?? '')}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { sm?: boolean }>(function Input(
  { className = '', sm, ...rest },
  ref,
) {
  return <input ref={ref} className={`input ${sm ? 'input-sm' : ''} ${className}`} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={`select ${className}`} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...rest },
  ref,
) {
  return <textarea ref={ref} className={`textarea ${className}`} {...rest} />;
});

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  const id = useId();
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/**
 * Decimal input bound to an integer value at `scale` decimals (money, qty,
 * percentages). Typing is free-form; the value is parsed on every keystroke and
 * re-formatted on blur. Accepts Arabic-Indic digits.
 */
export function DecimalInput({
  value,
  onChange,
  scale,
  placeholder,
  sm,
  className = '',
  allowNegative = false,
  autoFocus,
  disabled,
  id,
  trim = false,
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange(v: number | null): void;
  scale: number;
  placeholder?: string;
  sm?: boolean;
  className?: string;
  allowNegative?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
  /** Hide trailing zeros when not editing (quantities, percentages). */
  trim?: boolean;
  'aria-label'?: string;
}) {
  // Unfocused: grouped for reading ("12,500.00"). Focused: plain for editing ("12500.00").
  const display = (v: number | null) => {
    if (v == null) return '';
    const s = formatMinor(v, scale, 'en');
    return trim && scale > 0 ? s.replace(/\.?0+$/, '') : s;
  };
  const [text, setText] = useState(() => display(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(display(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, scale, focused, trim]);
  const parsed = parseDecimal(text, scale);
  const invalid = text.trim() !== '' && (parsed == null || (!allowNegative && parsed < 0));
  return (
    <input
      id={id}
      className={`input num ${sm ? 'input-sm' : ''} ${className}`}
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      aria-invalid={invalid}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      disabled={disabled}
      onFocus={(e) => {
        setFocused(true);
        const plain = toEditable(value, scale);
        setText(trim && scale > 0 ? plain.replace(/\.?0+$/, '') : plain);
        const el = e.target;
        requestAnimationFrame(() => el.select());
      }}
      onBlur={() => {
        setFocused(false);
        setText(display(parsed != null && (allowNegative || parsed >= 0) ? parsed : value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseDecimal(e.target.value, scale);
        if (e.target.value.trim() === '') onChange(null);
        else if (v != null && (allowNegative || v >= 0)) onChange(v);
      }}
    />
  );
}
