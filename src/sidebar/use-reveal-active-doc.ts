import { useCallback, useEffect, useRef } from 'react';

interface RevealableDoc {
  filename: string;
  isActive?: boolean;
}

export function useRevealActiveDoc(
  scrollRef: React.RefObject<HTMLElement>,
  docs: RevealableDoc[],
  treeSignal: number,
  expandAncestors?: (filename: string) => void,
) {
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const expandRef = useRef(expandAncestors);
  expandRef.current = expandAncestors;
  const directedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reveal = useCallback((filename: string | undefined) => {
    const target = filename || docsRef.current.find((d) => d.isActive)?.filename;
    if (!target) return;
    expandRef.current?.(target);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const root = scrollRef.current;
      if (!root) return;
      const el = (root.querySelector(`[data-drag-id="${CSS.escape(target)}"]`) || root.querySelector('.active')) as HTMLElement | null;
      if (!el || el.offsetParent === null) return;

      const directed = directedRef.current === target;
      const r = el.getBoundingClientRect();
      const rr = root.getBoundingClientRect();
      const offscreen = r.top < rr.top || r.bottom > rr.bottom;

      if (directed || offscreen) {
        const delta = (r.top - rr.top) - (rr.height / 2 - r.height / 2);
        root.scrollTop += delta;
      }

      if (directed) {
        directedRef.current = null;
        el.classList.remove('reveal-pulse');
        void el.offsetWidth;
        el.classList.add('reveal-pulse');
        setTimeout(() => el.classList.remove('reveal-pulse'), 1200);
      }
    }, 60);
  }, [scrollRef]);

  const activeFilename = docs.find((d) => d.isActive)?.filename;
  useEffect(() => {
    reveal(activeFilename);
  }, [activeFilename, treeSignal, reveal]);

  useEffect(() => {
    const handler = (e: Event) => {
      const fn = (e as CustomEvent).detail?.filename || docsRef.current.find((d) => d.isActive)?.filename;
      if (!fn) return;
      directedRef.current = fn;
      reveal(fn);
    };
    window.addEventListener('ow-reveal-active-doc', handler);
    return () => window.removeEventListener('ow-reveal-active-doc', handler);
  }, [reveal]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
}
