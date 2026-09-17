/**
 * Persistent row of tab icons inside the rail's column.
 */
import { useEffect, useState } from 'react';
import { useRightRail } from './RightRailContext';
import { TAB_REGISTRY } from './tabs';
import type { PendingDocsPayload } from '../ws/client';

interface RailIconStripProps {
  pendingDocs: PendingDocsPayload;
}

let lastPendingCount = 0;

export default function RailIconStrip({ pendingDocs }: RailIconStripProps) {
  const { visible, activeTab, openTab } = useRightRail();
  const [pulsingReview, setPulsingReview] = useState(false);

  useEffect(() => {
    const cur = pendingDocs.filenames.length;
    const prev = lastPendingCount;
    lastPendingCount = cur;
    if (prev === 0 && cur > 0) openTab('review');
  }, [pendingDocs.filenames.length, openTab]);

  useEffect(() => {
    const handler = () => openTab('review');
    window.addEventListener('ow-pending-write-applied', handler);
    return () => window.removeEventListener('ow-pending-write-applied', handler);
  }, [openTab]);

  useEffect(() => {
    const handler = () => {
      if (visible && activeTab === 'review') return;
      setPulsingReview(true);
      window.setTimeout(() => setPulsingReview(false), 500);
    };
    window.addEventListener('ow-pending-write-applied', handler);
    return () => window.removeEventListener('ow-pending-write-applied', handler);
  }, [visible, activeTab]);

  return (
    <div
      className="rail-icon-strip"
      role="tablist"
      aria-label="Right rail tabs"
    >
      {TAB_REGISTRY.map((tab) => {
        const selected = visible && activeTab === tab.id;
        const isReview = tab.id === 'review';
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={[
              'rail-icon-btn',
              selected ? 'rail-icon-btn--active' : '',
              `rail-icon-btn--scope-${tab.scope}`,
              isReview && pulsingReview ? 'rail-icon-btn--pulsing' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => openTab(tab.id)}
            title={tab.label}
            data-tour-id={tab.id}
            aria-label={tab.label}
          >
            {tab.icon}
          </button>
        );
      })}
    </div>
  );
}
