/**
 * Right rail — full-height column on the right side of the app, mirroring
 * the left sidebar's structural rhythm:
 *
 *   topbar (48px, matches sidebar-topbar)
 *   icon strip (36px, matches search row)
 *   body (rest)
 *
 * border-left extends from top to bottom of the viewport. Resizable from
 * the left edge. Closing the rail collapses it to width 0; a toggle in
 * the titlebar brings it back.
 *
 * The rail topbar holds chrome that used to live in the global titlebar:
 * HideRail close button (far-left, inward edge — mirror of sidebar's
 * collapse button on its right edge) and the format-toolbar toggle.
 * writer-app does not ship the fork's sync or voice subsystems, so those
 * seams are cut.
 *
 * adr: adr/right-rail.md
 */
import { useCallback, useEffect, useRef } from 'react';
import './RightRail.css';
import { useRightRail } from './RightRailContext';
import RailIconStrip from './RailIconStrip';
import RailBody from './RailBody';
import { HideRailIcon } from './icons';
import type { RightRailTabProps } from './types';

interface RightRailProps extends RightRailTabProps {
  onToggleToolbar: () => void;
  toolbarOpen: boolean;
}

export default function RightRail(props: RightRailProps) {
  const { onToggleToolbar, toolbarOpen, ...tabProps } = props;
  const { open, visible, overlay, width, setWidth, closeRail } = useRightRail();
  const ref = useRef<HTMLElement>(null);

  // Drag-to-resize on the left (inner) edge — single handle spans the full
  // column height so the user can grab it anywhere along the rail's left
  // border. Pulling LEFT (negative dx) grows the rail.
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX;
      setWidth(startWidth + dx);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [width, setWidth]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!ref.current) return;
      if (ref.current.contains(document.activeElement)) {
        e.preventDefault();
        closeRail();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, closeRail]);


  // The column stays mounted whether open or closed and collapses its width
  // to 0 on close — mirroring the left sidebar exactly, so the hide/show
  // animation matches (instant open via the inline-width `transition: none`
  // rule, animated close via the base width transition). Keeping it mounted
  // also keeps the auto-open-Review hook watching pendingDocs.
  // `visible` (not `open`) is the effective showing state — in overlay mode
  // it tracks the transient drawer.
  const collapsed = !visible;

  return (
    <aside
      ref={ref}
      className={`right-rail-column${collapsed ? '' : ' open'}`}
      style={collapsed ? undefined : { width, minWidth: width }}
      aria-label="Right rail"
    >
      {/* Drag-to-resize is docked-only; in overlay the drawer uses its saved width. */}
      {!overlay && !collapsed && <div className="right-rail-resize-handle" onPointerDown={startResize} aria-hidden="true" />}
      <div className="right-rail-topbar">
        <div className="right-rail-topbar-actions right-rail-topbar-actions--start">
          <button
            type="button"
            className="right-rail-topbar-btn"
            onClick={closeRail}
            title="Hide rail"
            aria-label="Hide rail"
          >
            <HideRailIcon />
          </button>
          <button
            type="button"
            className={`right-rail-topbar-btn${toolbarOpen ? ' right-rail-topbar-btn--active' : ''}`}
            onClick={onToggleToolbar}
            title="Toggle format toolbar"
            aria-label="Toggle format toolbar"
            aria-pressed={toolbarOpen}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16" />
              <path d="m6 16 6-12 6 12" />
              <path d="M8 12h8" />
            </svg>
          </button>
        </div>
      </div>
      <RailIconStrip pendingDocs={tabProps.pendingDocs} />
      <RailBody {...tabProps} />
    </aside>
  );
}
