import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info, X } from 'lucide-react';

// A small "i" button that explains how a feature works. Click or tap to open; Esc, a click elsewhere or
// scrolling closes it. The card is placed on screen (fixed) so it never runs off the edge on a phone.
export function InfoTip({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null), card = useRef<HTMLDivElement>(null);
  const id = useId();
  function toggle() {
    if (open) { setOpen(false); return; }
    const rect = button.current!.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
    const below = rect.bottom + 8, room = window.innerHeight - below;
    setPlace({ top: room < 220 && rect.top > 240 ? Math.max(12, rect.top - 8 - 220) : below, left });
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (event.type === 'keydown' ? (event as KeyboardEvent).key === 'Escape' : !card.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false); };
    const shut = () => setOpen(false);
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', close);
    window.addEventListener('scroll', shut, true); window.addEventListener('resize', shut);
    card.current?.focus();
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); window.removeEventListener('scroll', shut, true); window.removeEventListener('resize', shut); };
  }, [open]);
  return <>
    <button ref={button} type="button" className={`info-tip${open ? ' open' : ''}`} aria-label={label || `How ${title.toLowerCase()} works`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}><Info size={14} /></button>
    {open && <div ref={card} id={id} role="dialog" aria-label={title} tabIndex={-1} className="info-tip-card" style={{ top: place.top, left: place.left }}>
      <header><strong>{title}</strong><button type="button" className="icon-button" aria-label="Close" onClick={() => { setOpen(false); button.current?.focus(); }}><X size={14} /></button></header>
      <div className="info-tip-body">{children}</div>
    </div>}
  </>;
}
