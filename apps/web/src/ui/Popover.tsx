import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * A floating panel anchored to an element (menus, column filters). Rendered in
 * a portal so scrolling tables never clip it; closes on outside click or Esc.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  width,
  align = 'start',
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  width?: number;
  align?: 'start' | 'end';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => anchor.current && setRect(anchor.current.getBoundingClientRect());
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, onClose, anchor]);

  if (!open || !rect) return null;
  const rtl = document.dir === 'rtl';
  const w = width ?? 280;
  // "start" follows the reading direction; keep the panel inside the window.
  const alignLeft = (align === 'start') !== rtl;
  let left = alignLeft ? rect.left : rect.right - w;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  const below = window.innerHeight - rect.bottom > 320 || rect.top < 320;
  return createPortal(
    <div
      ref={ref}
      className="popover"
      style={{
        position: 'fixed',
        left,
        width: w,
        top: below ? rect.bottom + 6 : undefined,
        bottom: below ? undefined : window.innerHeight - rect.top + 6,
        maxHeight: below ? window.innerHeight - rect.bottom - 16 : rect.top - 16,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
