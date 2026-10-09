import { useEffect, useRef, type ReactNode } from 'react';

let openDialogs = 0;
let originalOverflow = '';
const focusable = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';

export function Modal({ children, onClose, wide = false }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (openDialogs++ === 0) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    const isTop = () => Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) === element;
    const controls = () => Array.from(element.querySelectorAll<HTMLElement>(focusable));
    if (isTop()) (element.querySelector<HTMLElement>('[autofocus]') ?? controls()[0] ?? element).focus();
    const handler = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0] ?? element;
        const last = items.at(-1) ?? element;
        if (!element.contains(document.activeElement) || document.activeElement === element ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      if (--openDialogs === 0) document.body.style.overflow = originalOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="操作窗口" tabIndex={-1}
      className={`modal${wide ? ' modal-wide' : ''}`}>{children}</div>
  </div>;
}
