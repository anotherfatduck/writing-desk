/**
 * Review tab — pending agent changes for the active doc.
 *
 * Migrated from src/review/ReviewPanel.tsx. Trimmed for the M2 lift:
 * workspace scope filter and manuscript rail sections removed (sidebar/manuscript
 * surfaces are not carried); core pending-overlay review cycle remains.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { usePendingState, derivePendingState } from '../../hooks/usePendingState';
import { setPreviewState, isPreviewActive, getSavedModifiedContent, getPreviewGroupId } from '../../decorations/plugin';
import { findNodeById, findGroupMembers } from '../../decorations/apply';
import { showToast } from '../../utils/toast';
import type { RightRailTabProps } from '../types';

const s = { strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ChevronLeft = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" {...s} /></svg>;
const ChevronRight = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" {...s} /></svg>;
const ChevronUp = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 10l5-5 5 5" stroke="currentColor" {...s} /></svg>;
const ChevronDown = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" {...s} /></svg>;
const Check = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" {...s} /></svg>;
const DoubleCheck = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8.5l3.5 3.5L11 5" stroke="currentColor" {...s} /><path d="M8 12l.5.5L15 6" stroke="currentColor" {...s} /></svg>;
const XIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" {...s} /></svg>;

function replaceNodeContent(editor: Editor, nodeId: string, newContent: any): boolean {
  const result = findNodeById(editor, nodeId);
  if (!result) return false;
  const { pos, node } = result;
  const replacement = {
    type: newContent.type || node.type.name,
    attrs: {
      ...(newContent.attrs || {}),
      id: node.attrs.id,
      pendingStatus: node.attrs.pendingStatus,
      pendingOriginalContent: node.attrs.pendingOriginalContent,
      pendingSelectionFrom: node.attrs.pendingSelectionFrom,
      pendingSelectionTo: node.attrs.pendingSelectionTo,
      pendingOriginalFrom: node.attrs.pendingOriginalFrom,
      pendingOriginalTo: node.attrs.pendingOriginalTo,
    },
    content: newContent.content,
  };
  try {
    editor.chain()
      .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; })
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .insertContentAt(pos, replacement)
      .run();
    return true;
  } catch { return false; }
}

function replaceGroupRange(editor: Editor, groupId: string, newContent: any[]): boolean {
  const members = findGroupMembers(editor, groupId);
  if (members.length === 0) return false;
  const rangeFrom = members[0].pos;
  const rangeTo = members[members.length - 1].pos + members[members.length - 1].node.nodeSize;
  try {
    editor.chain()
      .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; })
      .deleteRange({ from: rangeFrom, to: rangeTo })
      .insertContentAt(rangeFrom, newContent)
      .run();
    return true;
  } catch { return false; }
}

function restoreIfPreviewing(editor: Editor, previewingNodeId: string | null): boolean {
  if (!isPreviewActive() || !previewingNodeId) return false;
  const modified = getSavedModifiedContent();
  const groupId = getPreviewGroupId();
  if (groupId && modified && Array.isArray(modified)) {
    replaceGroupRange(editor, previewingNodeId, modified);
  } else if (modified) {
    replaceNodeContent(editor, previewingNodeId, modified);
  }
  setPreviewState(false);
  return true;
}

function GateBanner({ gate, note }: { gate: NonNullable<RightRailTabProps['reviewGate']>; note: string | null }) {
  const at = new Date(gate.since).toLocaleString();
  const label = gate.phase === 'submitted' ? 'Sent for review'
    : gate.phase === 'in-review' ? `In review since ${at}`
    : gate.phase === 'published' ? `In the library ${at}`
    : gate.phase === 'conflict' ? `Needs attention since ${at}`
    : `Returned with notes ${at}`;
  return (
    <div className="review-tab__gate" data-phase={gate.phase}>
      <div className="review-tab__gate-title">{label}</div>
      {gate.phase === 'submitted' && (
        <div className="review-tab__gate-note">Your article went to the library as a review copy. The reviewer approves it there, or sends it back with notes.</div>
      )}
      {gate.phase === 'published' && (
        <div className="review-tab__gate-note">The approved copy is in the library. Keep writing — edits you make here can go back for review as an update.</div>
      )}
      {gate.phase === 'returned' && note !== null && (
        <pre className="review-tab__gate-note">{note}</pre>
      )}
      {gate.phase === 'conflict' && (
        note !== null
          ? <pre className="review-tab__gate-note">{note}</pre>
          : <div className="review-tab__gate-note">This article was approved in the library, but your desk copy had also changed since you submitted, so the approved copy was not written back. Nothing is lost. Restore the approved version from the History tab (or bring your desk copy in line with it), then submit again for a fresh review.</div>
      )}
    </div>
  );
}

export default function ReviewTab({
  editors,
  pendingDocs,
  currentFilename,
  docId,
  docTitle,
  pendingTitle,
  onSwitchDocument,
  sendMessage,
  getDocument,
  docVersionRef,
  reviewGate,
  reviewNote,
}: RightRailTabProps) {
  const {
    counts,
    currentNode,
    currentIndex,
    hasPending,
    goToNext,
    goToPrevious,
    acceptCurrent,
    rejectCurrent,
    acceptAll,
    rejectAll,
  } = usePendingState(editors);

  const [cursor, setCursor] = useState<'title' | 'body'>(pendingTitle ? 'title' : 'body');
  const [submitting, setSubmitting] = useState(false);
  // Submit gate (M4e UAT review): submitting is not saving — it files the
  // article for editorial review. The button opens a confirmation that
  // requires the writer to acknowledge the article is done before the
  // request fires.
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  const [ackReady, setAckReady] = useState(false);

  useEffect(() => {
    if (pendingTitle && cursor !== 'title' && counts.total === 0) {
      setCursor('title');
    } else if (!pendingTitle && cursor === 'title') {
      setCursor('body');
    }
  }, [pendingTitle, counts.total, cursor]);

  const hasTitleSlot = !!pendingTitle;
  const totalSlots = counts.total + (hasTitleSlot ? 1 : 0);
  const slotIndex = cursor === 'title' ? 0 : (hasTitleSlot ? 1 : 0) + currentIndex;

  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    if (cursor !== 'title') setShowOriginal(false);
  }, [cursor]);

  const acceptPendingTitleAction = useCallback(() => {
    if (!docId) return;
    sendMessage({ type: 'accept-pending-title', docId });
  }, [docId, sendMessage]);
  const rejectPendingTitleAction = useCallback(() => {
    if (!docId) return;
    sendMessage({ type: 'reject-pending-title', docId });
  }, [docId, sendMessage]);

  const previewNodeIdRef = useRef<string | null>(null);
  const previewEditorRef = useRef<Editor | null>(null);

  const isRewrite = currentNode?.pendingStatus === 'rewrite';
  const isGroup = !!currentNode?.groupId;
  const canPreview = isRewrite;

  const togglePreview = useCallback(() => {
    const editor = currentNode?.editor;
    if (!editor || !currentNode || currentNode.pendingStatus !== 'rewrite') return;

    if (!showOriginal) {
      if (isGroup && currentNode.groupId) {
        const members = findGroupMembers(editor, currentNode.groupId);
        if (members.length === 0) return;
        const originalContent = members[0].node.attrs?.pendingOriginalContent;
        if (!originalContent || !Array.isArray(originalContent)) return;
        const modifiedJsons = members.map((m) => m.node.toJSON());
        const previewNodes = originalContent.map((orig: any, i: number) => ({
          ...orig,
          attrs: {
            ...(orig.attrs || {}),
            pendingStatus: 'rewrite',
            pendingGroupId: currentNode.groupId,
            ...(i === 0 ? { pendingOriginalContent: originalContent } : {}),
          },
        }));
        setPreviewState(true, currentNode.nodeId, modifiedJsons, currentNode.groupId);
        const swapped = replaceGroupRange(editor, currentNode.groupId, previewNodes);
        if (!swapped) {
          setPreviewState(false);
          return;
        }
        previewNodeIdRef.current = currentNode.nodeId;
        previewEditorRef.current = editor;
        setShowOriginal(true);
      } else {
        const result = findNodeById(editor, currentNode.nodeId);
        if (!result) return;
        const { node } = result;
        const originalContent = node.attrs?.pendingOriginalContent;
        if (!originalContent) return;
        const modifiedJson = node.toJSON();
        setPreviewState(true, currentNode.nodeId, modifiedJson);
        const swapped = replaceNodeContent(editor, currentNode.nodeId, originalContent);
        if (!swapped) {
          setPreviewState(false);
          return;
        }
        previewNodeIdRef.current = currentNode.nodeId;
        previewEditorRef.current = editor;
        setShowOriginal(true);
      }
    } else {
      if (previewEditorRef.current) {
        restoreIfPreviewing(previewEditorRef.current, previewNodeIdRef.current);
      }
      previewNodeIdRef.current = null;
      previewEditorRef.current = null;
      setShowOriginal(false);
    }
  }, [currentNode, showOriginal, isGroup]);

  useEffect(() => {
    if (!showOriginal) return;
    const prevNodeId = previewNodeIdRef.current;
    const prevEditor = previewEditorRef.current;
    if (prevNodeId && prevEditor && currentNode?.nodeId !== prevNodeId) {
      restoreIfPreviewing(prevEditor, prevNodeId);
      previewNodeIdRef.current = null;
      previewEditorRef.current = null;
      setShowOriginal(false);
    }
  }, [currentNode?.nodeId, showOriginal]);

  useEffect(() => {
    if (editors.length === 0) return;
    return () => {
      if (isPreviewActive() && previewNodeIdRef.current && previewEditorRef.current) {
        restoreIfPreviewing(previewEditorRef.current, previewNodeIdRef.current);
        previewNodeIdRef.current = null;
        previewEditorRef.current = null;
      }
    };
  }, [editors]);

  const checkResolution = useCallback((action: 'accept' | 'reject') => {
    if (!currentFilename) return;
    const hasRemaining = editors.some((e) => {
      if (!e || e.isDestroyed) return false;
      return derivePendingState(e).length > 0;
    });
    if (!hasRemaining) {
      const doc = getDocument?.();
      if (doc) {
        sendMessage({ type: 'doc-update', document: doc, filename: currentFilename, version: docVersionRef?.current ?? 0 });
      }
      sendMessage({ type: 'pending-resolved', filename: currentFilename, action });
    }
  }, [editors, currentFilename, sendMessage, getDocument, docVersionRef]);

  const restorePreviewIfActive = useCallback(() => {
    if (previewEditorRef.current && showOriginal && previewNodeIdRef.current) {
      restoreIfPreviewing(previewEditorRef.current, previewNodeIdRef.current);
      previewNodeIdRef.current = null;
      previewEditorRef.current = null;
      setShowOriginal(false);
    }
  }, [showOriginal]);

  const handleAcceptCurrent = useCallback(() => {
    if (cursor === 'title' && pendingTitle) {
      acceptPendingTitleAction();
      if (counts.total > 0) setCursor('body');
      return;
    }
    restorePreviewIfActive();
    acceptCurrent();
    checkResolution('accept');
  }, [cursor, pendingTitle, acceptPendingTitleAction, counts.total, restorePreviewIfActive, acceptCurrent, checkResolution]);

  const handleRejectCurrent = useCallback(() => {
    if (cursor === 'title' && pendingTitle) {
      rejectPendingTitleAction();
      if (counts.total > 0) setCursor('body');
      return;
    }
    restorePreviewIfActive();
    rejectCurrent();
    checkResolution('reject');
  }, [cursor, pendingTitle, rejectPendingTitleAction, counts.total, restorePreviewIfActive, rejectCurrent, checkResolution]);

  const handleAcceptAll = useCallback(() => {
    restorePreviewIfActive();
    if (pendingTitle) acceptPendingTitleAction();
    acceptAll();
    checkResolution('accept');
  }, [restorePreviewIfActive, pendingTitle, acceptPendingTitleAction, acceptAll, checkResolution]);

  const handleRejectAll = useCallback(() => {
    restorePreviewIfActive();
    if (pendingTitle) rejectPendingTitleAction();
    rejectAll();
    checkResolution('reject');
  }, [restorePreviewIfActive, pendingTitle, rejectPendingTitleAction, rejectAll, checkResolution]);

  const totalPendingDocs = pendingDocs.filenames.length;
  const currentDocIndex = useMemo(() => pendingDocs.filenames.indexOf(currentFilename), [pendingDocs.filenames, currentFilename]);

  const goToPreviousDoc = useCallback(() => {
    if (totalPendingDocs === 0) return;
    if (totalPendingDocs === 1 && currentDocIndex === 0) return;
    const idx = currentDocIndex <= 0 ? totalPendingDocs - 1 : currentDocIndex - 1;
    onSwitchDocument(pendingDocs.filenames[idx]);
  }, [totalPendingDocs, currentDocIndex, pendingDocs.filenames, onSwitchDocument]);

  const goToNextDoc = useCallback(() => {
    if (totalPendingDocs === 0) return;
    if (totalPendingDocs === 1 && currentDocIndex === 0) return;
    const idx = currentDocIndex >= totalPendingDocs - 1 ? 0 : currentDocIndex + 1;
    onSwitchDocument(pendingDocs.filenames[idx]);
  }, [totalPendingDocs, currentDocIndex, pendingDocs.filenames, onSwitchDocument]);

  // Cycle-aware navigation: title is virtual slot 0 when staged; body changes
  // follow. j/k and ↑/↓ cycle through every slot in order.
  const handleGoToNext = useCallback(() => {
    if (totalSlots <= 1) return;
    if (cursor === 'title') {
      // Title → body[0]. Body's internal cursor is already 0 by invariant.
      setCursor('body');
      return;
    }
    // cursor === 'body'
    if (hasTitleSlot && currentIndex >= counts.total - 1) {
      // At last body → wrap body to body[0] (so the invariant holds), then
      // flip cursor to title.
      goToNext();
      setCursor('title');
      return;
    }
    goToNext();
  }, [totalSlots, cursor, hasTitleSlot, currentIndex, counts.total, goToNext]);

  const handleGoToPrevious = useCallback(() => {
    if (totalSlots <= 1) return;
    if (cursor === 'title') {
      // Title → body[last]. Body's internal cursor is 0 by invariant, so
      // goToPrevious wraps 0 → last via modulo. Then flip cursor.
      goToPrevious();
      setCursor('body');
      return;
    }
    if (hasTitleSlot && currentIndex === 0) {
      // At body[0] backward → flip cursor to title without moving body
      // (which is already at 0; invariant preserved).
      setCursor('title');
      return;
    }
    goToPrevious();
  }, [totalSlots, cursor, hasTitleSlot, currentIndex, goToPrevious]);

  useEffect(() => {
    if (!hasPending && !pendingTitle) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.closest('[contenteditable]')) return;

      switch (e.key) {
        case 'j': case 'ArrowDown':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); goToNext(); } break;
        case 'k': case 'ArrowUp':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); goToPrevious(); } break;
        case 'h': case 'ArrowLeft':
          if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); goToPreviousDoc(); } break;
        case 'l': case 'ArrowRight':
          if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); goToNextDoc(); } break;
        case 'a':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); handleAcceptCurrent(); } break;
        case 'r':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); handleRejectCurrent(); } break;
        case 'A':
          if (e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleAcceptAll(); } break;
        case 'R':
          if (e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleRejectAll(); } break;
        case 'o':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            if (cursor === 'title') {
              setShowOriginal((v) => !v);
            } else {
              togglePreview();
            }
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasPending, pendingTitle, goToNext, goToPrevious, goToPreviousDoc, goToNextDoc, handleAcceptCurrent, handleRejectCurrent, handleAcceptAll, handleRejectAll, togglePreview, cursor]);

  const docCounterText = currentDocIndex >= 0
    ? `${currentDocIndex + 1} / ${totalPendingDocs}`
    : `— / ${totalPendingDocs}`;

  // Escape cancels the submit gate while it's open.
  useEffect(() => {
    if (!confirmingSubmit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) setConfirmingSubmit(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingSubmit, submitting]);

  async function doSubmit() {
    setSubmitting(true);
    try {
      const r = await fetch('/api/review-gate/submit', { method: 'POST' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        showToast(j.error || 'Submit failed — try again', 'error');
      }
    } catch {
      // Fetch rejection (offline/hiccup): F8's toast fired only on !r.ok —
      // a rejected fetch left submit silently failed. Same surface, same copy.
      showToast('Submit failed — try again', 'error');
    } finally {
      setSubmitting(false);
      setConfirmingSubmit(false);
      setAckReady(false);
    }
  }

  if (!hasPending && !pendingTitle) {
    const articleName = docTitle?.trim() ? docTitle.trim() : 'Untitled';
    // The submit affordance shows for a draft (no gate) and for update rounds:
    // a published article's edits, a returned article's fixes, or a conflict
    // resolution re-enter review as a fresh cycle (the orchestrator opens a new PR — one per
    // cycle). In-flight phases (submitted/in-review) correctly show nothing.
    const submitOpen = !reviewGate || reviewGate.phase === 'published' || reviewGate.phase === 'returned' || reviewGate.phase === 'conflict';
    const submitNote = !reviewGate
      ? 'Done writing? Send the article to the library for the reviewer to approve.'
      : reviewGate.phase === 'published'
        ? 'Edits since publication? Send them to the library as a new review round.'
        : 'Addressed the notes? Submit again — a fresh submission starts a new review.';
    return (
      <div className="review-tab__empty-wrap">
        {reviewGate && <GateBanner gate={reviewGate} note={reviewNote ?? null} />}
        {submitOpen && (
          <div className="review-tab__submit">
            <div className="review-tab__submit-note">{submitNote}</div>
            <button
              className="review-tab__submit-btn"
              onClick={() => { setConfirmingSubmit(true); setAckReady(false); }}
              disabled={submitting}
            >
              {submitting ? 'Sending…' : 'Submit for approval'}
            </button>
          </div>
        )}
        <div className="review-tab__empty">
          <div className="review-tab__empty-title">All caught up</div>
          <div className="review-tab__empty-note">No pending agent changes. New writes from agents will land here for review.</div>
        </div>

        {confirmingSubmit && (
          <div className="submit-gate" onClick={() => { if (!submitting) setConfirmingSubmit(false); }}>
            <div className="submit-gate__card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="submit-gate-title">
              <div className="submit-gate__title" id="submit-gate-title">Submit for editorial review?</div>
              <p className="submit-gate__body">
                "{articleName}" goes to the library as a review copy. The reviewer will
                approve it into the library or return it with notes. Your desk keeps
                the draft either way.
              </p>
              <label className="submit-gate__ack">
                <input
                  type="checkbox"
                  checked={ackReady}
                  onChange={(e) => setAckReady(e.target.checked)}
                />
                This article is done and ready for editorial review.
              </label>
              <div className="submit-gate__actions">
                <button
                  type="button"
                  className="submit-gate__btn submit-gate__btn--cancel"
                  onClick={() => setConfirmingSubmit(false)}
                  disabled={submitting}
                >
                  Keep writing
                </button>
                <button
                  type="button"
                  className="submit-gate__btn submit-gate__btn--confirm"
                  onClick={doSubmit}
                  disabled={!ackReady || submitting}
                >
                  {submitting ? 'Sending…' : 'Submit for review'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="review-tab">
      {reviewGate && <GateBanner gate={reviewGate} note={reviewNote ?? null} />}
      {totalPendingDocs > 1 && (
        <div className="review-tab__section">
          <div className="review-tab__section-label">Document</div>
          <div className="review-tab__row">
            <button className="review-panel__btn" onClick={goToPreviousDoc} title="Previous doc (h)"><ChevronLeft /></button>
            <button className="review-panel__btn" onClick={goToNextDoc} title="Next doc (l)"><ChevronRight /></button>
            <span className="review-panel__counter">{docCounterText}</span>
          </div>
        </div>
      )}

      <div className="review-tab__section review-tab__section--actions">
        <div className="review-tab__toggle">
          <button
            className={`review-panel__toggle-btn${(canPreview || cursor === 'title') && !showOriginal ? ' review-panel__toggle-btn--active' : ''}`}
            onClick={() => {
              if (cursor === 'title') {
                if (showOriginal) setShowOriginal(false);
              } else if (canPreview && showOriginal) {
                togglePreview();
              }
            }}
            disabled={!canPreview && cursor !== 'title'}
            title="Show modified (o)"
          >
            Modified
          </button>
          <button
            className={`review-panel__toggle-btn${(canPreview || cursor === 'title') && showOriginal ? ' review-panel__toggle-btn--active' : ''}`}
            onClick={() => {
              if (cursor === 'title') {
                if (!showOriginal) setShowOriginal(true);
              } else if (canPreview && !showOriginal) {
                togglePreview();
              }
            }}
            disabled={!canPreview && cursor !== 'title'}
            title="Show original (o)"
          >
            Original
          </button>
        </div>
      </div>

      <div className="review-tab__section">
        <div className="review-tab__section-label">{cursor === 'title' ? 'Title' : 'Change'}</div>
        <div className="review-tab__row">
          <button className="review-panel__btn" onClick={handleGoToPrevious} disabled={totalSlots <= 1} title="Previous (k)"><ChevronUp /></button>
          <button className="review-panel__btn" onClick={handleGoToNext} disabled={totalSlots <= 1} title="Next (j)"><ChevronDown /></button>
          <span className="review-panel__counter">{slotIndex + 1} / {totalSlots}</span>
        </div>
      </div>

      <div className="review-tab__section">
        <div className="review-tab__row">
          <button className="review-tab__judge-btn review-tab__judge-btn--accept" onClick={handleAcceptCurrent} title="Accept (a)"><Check /><span>Accept</span></button>
          <button className="review-tab__judge-btn review-tab__judge-btn--reject" onClick={handleRejectCurrent} title="Reject (r)"><XIcon /><span>Reject</span></button>
        </div>
      </div>

      <div className="review-tab__section">
        <div className="review-tab__row">
          <button className="review-tab__bulk-btn review-tab__bulk-btn--accept" onClick={handleAcceptAll} title="Accept all (Shift+A)"><DoubleCheck /><span>Accept all</span></button>
          <button className="review-tab__bulk-btn review-tab__bulk-btn--reject" onClick={handleRejectAll} title="Reject all (Shift+R)"><XIcon /><span>Reject all</span></button>
        </div>
      </div>
    </div>
  );
}
