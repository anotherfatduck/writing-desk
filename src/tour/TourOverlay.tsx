/**
 * TourOverlay — the first-run click-through tour (spec 2026-09-13).
 * One dim layer with a spotlight cutout; the card clamps to the target.
 * The dim layer swallows every click: tour navigation is explicit only.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRightRail } from '../right-rail/RightRailContext';
import { TOUR_STEPS, markTourSeen, type TourStep } from './tour-state';
import './tour.css';

interface TourOverlayProps {
  userId: string;
  onEnsureSidebar: () => void;
  onFinish: () => void;
}

interface Rect { top: number; left: number; width: number; height: number; }

export default function TourOverlay({ userId, onEnsureSidebar, onFinish }: TourOverlayProps) {
  const { openTab, activeTab } = useRightRail();
  const prevTabRef = useRef(activeTab);   // rail tab to restore at tour end
  const changedRailRef = useRef(false);   // did a tour step open a rail tab?
  const finishedRef = useRef(false);      // did finish() already restore?
  const openTabRef = useRef(openTab);     // latest openTab for the unmount cleanup
  openTabRef.current = openTab;
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(220);        // measured card height (M3)
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight }); // Rider A: render reads recompute on resize
  const [settled, setSettled] = useState(false);  // M1: no phantom ring while the target settles
  const cardRef = useRef<HTMLDivElement>(null);
  const step: TourStep = TOUR_STEPS[index];
  const last = index === TOUR_STEPS.length - 1;

  // Declarative per-step setup, then measure the target.
  useEffect(() => {
    document.body.classList.add('tour-active');
    setSettled(false);
    if (step.ensureSidebar) onEnsureSidebar();
    if (step.expandSection) {
      // Spec setup: "expand <section>". The expansion state is persisted per-browser,
      // so it may be collapsed. Programmatic setup click (spec-sanctioned — the
      // click-through guarantee covers user clicks reaching the app, not tour setup).
      const header = document.querySelector(`.files-row.is-section[data-section-key="${step.expandSection}"]`);
      const list = header?.nextElementSibling;
      if (header && list?.classList.contains('collapsed')) {
        header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
    if (step.openRailTab) { openTab(step.openRailTab); changedRailRef.current = true; }
    const measure = () => {
      // Rider A (packaging-lane final review): a stale cardH mis-clamps the
      // below/above flip, and target-less steps must re-render on resize too
      // (setRect(null)/setCardH(same) both bail out) — so the viewport rides
      // along as state, and the render-time window.* reads use it.
      setVp({ w: window.innerWidth, h: window.innerHeight });
      if (cardRef.current) setCardH(cardRef.current.offsetHeight);
      if (!step.target) { setRect(null); return; }
      const el = document.querySelector(step.target);
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true); // M4: sidebar + canvas scrolls move targets too
    // M1: re-measure each frame until the target settles (setup clicks shift
    // layout a frame or two after mount) instead of one blind 350ms retry —
    // that gap rendered the phantom ring on a collapsed rail. Gives up after
    // 600ms, then the phantom behavior applies (genuinely missing targets).
    let raf = 0;
    const deadline = performance.now() + 600;
    let lastKey = '';
    const tick = () => {
      measure();
      if (!step.target) { setSettled(true); return; } // target-less steps settle immediately
      const el = document.querySelector(step.target);
      const r = el?.getBoundingClientRect();
      const key = r && r.width > 0 ? `${r.top},${r.left},${r.width},${r.height}` : '';
      if ((key !== '' && key === lastKey) || performance.now() > deadline) {
        setSettled(true);
        return;
      }
      lastKey = key;
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      document.body.classList.remove('tour-active');
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.cancelAnimationFrame(raf);
    };
  }, [step, onEnsureSidebar, openTab]);

  // M3: measure the card's real height after render — the hardcoded 220 estimate
  // broke below/above flips whenever the copy wrapped taller or shorter. Re-runs
  // when `settled` flips: that's when the card actually mounts.
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [index, step, settled]);

  // M6: unmount without finish() (e.g. session loss mid-tour) — restore the
  // rail tab a tour step opened, exactly as finish() would have.
  useEffect(() => () => {
    if (!finishedRef.current && changedRailRef.current && prevTabRef.current) {
      openTabRef.current?.(prevTabRef.current);
    }
  }, []);

  const finish = useCallback(() => {
    finishedRef.current = true;
    if (changedRailRef.current && prevTabRef.current) openTab(prevTabRef.current);
    markTourSeen(userId);
    onFinish();
  }, [userId, onFinish, openTab]);

  const next = useCallback(() => { if (last) finish(); else setIndex(i => i + 1); }, [last, finish]);
  const back = useCallback(() => setIndex(i => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Rider B (packaging-lane final review; narrowed to Enter-only yield per
      // controller ruling 2026-09-13): with a card button focused, Enter lets
      // the button's native activation fire — Enter on focused Back goes
      // back, not tour-forward. A focused button has no native arrow
      // activation, so arrows stay tour keys (nav + preventDefault). Escape
      // still finishes.
      const onCardBtn = e.target instanceof HTMLElement && e.target.tagName === 'BUTTON' && !!cardRef.current?.contains(e.target);
      const enterOnCard = e.key === 'Enter' && onCardBtn;
      if (!enterOnCard && (e.key === 'Enter' || e.key === 'ArrowRight')) { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); back(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Rider C: arrows are tour dead keys — the page behind the overlay
        // must not scroll under the card.
        e.preventDefault();
      }
      else if (e.key === 'Escape') { e.preventDefault(); finish(); }
      else if (e.key === 'Tab') {
        // M5: the dim layer swallows clicks; the keyboard must not escape the
        // card either — cycle focus within the card's focusables.
        e.preventDefault();
        const card = cardRef.current;
        if (!card) return;
        const focusables = Array.from(card.querySelectorAll<HTMLElement>('button:not([disabled])'));
        if (focusables.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        const i = active ? focusables.indexOf(active) : -1;
        if (e.shiftKey) focusables[i > 0 ? i - 1 : focusables.length - 1].focus();
        else focusables[i >= 0 && i < focusables.length - 1 ? i + 1 : 0].focus();
      }
      else if (e.key === ' ') {
        // M5's face: Space with focus outside the card scrolls the page under
        // the tour. Inside the card, buttons keep their native activation.
        const t = e.target as HTMLElement | null;
        if (!t || !cardRef.current?.contains(t)) e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, finish, index]);

  // Per-step focus: autoFocus only fires on first mount — stepping forward
  // would otherwise strand focus on <body>. Depends on `settled` too: the card
  // mounts when the settle gate opens, and this must catch that mount.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>('.tour-btn--next')?.focus();
  }, [index, settled]);

  // Spotlight geometry. No resolvable target → phantom 0-size ring at screen
  // center: the card centers and the spread shadow still dims the page
  // (spec: "the card centers and the screen dims — no broken arrows").
  const spot: Rect = rect && rect.width > 0
    ? rect
    : { top: vp.h / 2, left: vp.w / 2, width: 0, height: 0 };

  // Card position: prefer below the target, flip above, clamp to the viewport.
  // No target (or unresolvable selector) → centered. Width clamps on narrow
  // viewports (final-review minor: the old 340 + 32 margins broke <372px).
  const cardW = Math.min(340, Math.max(240, vp.w - 32));
  const pad = 8;
  let cardStyle: React.CSSProperties;
  if (rect && rect.width > 0) {
    const below = rect.top + rect.height + pad + 12;
    const fitsBelow = below + cardH < vp.h;
    const top = fitsBelow ? below : Math.max(16, rect.top - pad - 12 - cardH);
    const left = Math.min(Math.max(16, rect.left), Math.max(16, vp.w - cardW - 16));
    cardStyle = { position: 'fixed', top, left, width: cardW };
  } else {
    cardStyle = { position: 'fixed', top: '38%', left: '50%', transform: 'translateX(-50%)', width: cardW };
  }

  return (
    <div className="tour-root">
      {/* Click-catcher: swallows every click so the tour is strictly click-through. */}
      <div className="tour-catcher" onClick={(e) => e.stopPropagation()} />
      {settled && (
        <>
          <div
            className={`tour-spotlight${rect && rect.width > 0 ? '' : ' tour-spotlight--phantom'}`}
            style={{ top: spot.top - pad, left: spot.left - pad, width: spot.width + pad * 2, height: spot.height + pad * 2 }}
          />
          <div className="tour-card" ref={cardRef} style={cardStyle} role="dialog" aria-modal="true" aria-label={step.title}>
            <button type="button" className="tour-skip" onClick={finish}>Skip tour</button>
            <h3 className="tour-title">{step.title}</h3>
            <p className="tour-body">{step.body}</p>
            <div className="tour-actions">
              {index > 0 && (
                <button type="button" className="tour-btn tour-btn--back" onClick={back}>Back</button>
              )}
              <span className="tour-progress">{index + 1} / {TOUR_STEPS.length}</span>
              <button type="button" className="tour-btn tour-btn--next" onClick={next}>
                {last ? 'Start writing' : 'Next'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
