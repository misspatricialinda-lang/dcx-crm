import { useEffect, useRef, type KeyboardEvent } from 'react';

// Ctrl+Z / Ctrl+Y for a text box whose value the app also replaces (AI rewrites, saves, reloads).
// The browser drops its own undo history whenever React sets the value, so keep our own.
// Bursts of typing become one step; every replacement from outside is its own step.
export function useUndoHistory(value: string, setValue: (next: string) => void, resetKey: unknown) {
  const state = useRef({ past: [] as string[], future: [] as string[], previous: value, typedAt: 0, typing: false, applying: false });
  useEffect(() => { state.current = { past: [], future: [], previous: value, typedAt: 0, typing: false, applying: false }; }, [resetKey]);
  useEffect(() => {
    const s = state.current;
    if (value === s.previous) { s.typing = false; return; }
    if (s.applying) s.applying = false;
    else {
      const now = Date.now();
      const sameBurst = s.typing && s.typedAt && now - s.typedAt < 800 && !value.endsWith('\n');
      if (!sameBurst) { s.past.push(s.previous); if (s.past.length > 200) s.past.shift(); }
      s.future = [];
      s.typedAt = s.typing ? now : 0;
    }
    s.typing = false; s.previous = value;
  }, [value]);
  function step(from: string[], to: string[]) {
    const s = state.current, target = from.pop();
    if (target === undefined) return;
    to.push(s.previous); s.applying = true; s.typedAt = 0; setValue(target);
  }
  return {
    // Use as the text box's onChange value setter so typing is grouped.
    typed(next: string) { state.current.typing = true; setValue(next); },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      event.preventDefault();
      const s = state.current;
      if (key === 'y' || event.shiftKey) step(s.future, s.past); else step(s.past, s.future);
    },
  };
}
