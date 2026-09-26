import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, iconOnly, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = [
    'btn',
    variant === 'primary' && 'btn-primary',
    variant === 'ghost' && 'btn-ghost',
    variant === 'danger' && 'btn-danger',
    size === 'sm' && 'btn-sm',
    size === 'lg' && 'btn-lg',
    iconOnly && 'btn-icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="spin" /> : icon}
      {children}
    </button>
  );
});
