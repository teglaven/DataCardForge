/**
 * Card canvas — the `QMdiArea` replacement.
 *
 * Owns the absolutely-positioned card plane, the backend-layer connection overlay,
 * the empty-state affordance, the right-click "new table" gesture and file drops.
 * All geometry lives in the store; this component only orchestrates.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { invalidateLayout, setCanvasElement } from '../cardMetrics.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { isFormulaCard, isMatrixCard } from '../types.ts';
import { ConnectionLayer } from '../ConnectionLayer.tsx';
import { CardShell } from './CardShell.tsx';
import { ChartCard } from './ChartCard.tsx';
import { FormulaCard } from './FormulaCard.tsx';
import { EmptyState } from './EmptyState.tsx';
import { MatrixCard } from './MatrixCard.tsx';

interface CardCanvasProps {
  onNewTable: () => void;
  onFilesDropped: (files: File[]) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

export function CardCanvas({ onNewTable, onFilesDropped, onContextMenu }: CardCanvasProps) {
  const { t } = useTranslator();
  const cards = useWorkspace((s) => s.cards);
  const matrices = useWorkspace((s) => s.matrices);
  const selectedId = useWorkspace((s) => s.selectedId);
  const blockedCardId = useWorkspace((s) => s.blockedCardId);
  const blockNonce = useWorkspace((s) => s.blockNonce);
  const dependencies = useWorkspace((s) => s.dependencies);
  const bringToFront = useWorkspace((s) => s.bringToFront);
  const select = useWorkspace((s) => s.select);
  const removeCard = useWorkspace((s) => s.removeCard);
  const addChartCard = useWorkspace((s) => s.addChartCard);
  const addFormulaCard = useWorkspace((s) => s.addFormulaCard);
  const showToast = useWorkspace((s) => s.showToast);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    setCanvasElement(canvasRef.current);
    return () => setCanvasElement(null);
  }, []);

  // Keep anchors fresh when the viewport itself changes size.
  useEffect(() => {
    window.addEventListener('resize', invalidateLayout);
    return () => window.removeEventListener('resize', invalidateLayout);
  }, []);

  /**
   * Surface the refusal to close a card that still has dependents: an error toast
   * plus a blink on its connection lines (the Qt version did the same).
   */
  const reportBlocked = useCallback(
    (cardId: number) => {
      showToast('error', t('status.closeBlocked'));
      // `blockedCardId` alone cannot restart a blink twice in a row, so the store
      // carries a nonce that changes on every refusal.
      useWorkspace.getState().blockCard(cardId);
    },
    [showToast, t],
  );

  /**
   * A matrix may only be closed once nothing depends on it. The store already
   * refuses the removal; here we surface why.
   */
  const handleClose = useCallback(
    (cardId: number) => {
      const state = useWorkspace.getState();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card) return;

      const blocked =
        isMatrixCard(card) && state.dependencies.hasDependents(card.id);

      if (blocked) {
        reportBlocked(cardId);
        return;
      }

      removeCard(cardId);
      invalidateLayout();
    },
    [removeCard, reportBlocked],
  );

  const renderedCards = useMemo(
    () =>
      cards.map((card) => {
        const active = selectedId === card.id;
        const closeBlocked = isMatrixCard(card) && dependencies.hasDependents(card.id);

        if (isMatrixCard(card)) {
          const source = card.sources[card.activeSource];
          return (
            <MatrixCard
              key={card.id}
              card={card}
              matrix={source ? matrices.get(source.matrixId) : undefined}
              active={active}
              closeBlocked={closeBlocked}
              onActivate={() => bringToFront(card.id)}
              onClose={() => handleClose(card.id)}
              onCloseBlocked={() => reportBlocked(card.id)}
              onOpenChart={(columnIndex, type) => {
                const id = addChartCard(card.id, columnIndex, type);
                if (id !== null) select(id);
              }}
              onOpenFormula={() => {
                const id = addFormulaCard(card.id);
                if (id !== null) select(id);
              }}
            />
          );
        }

        if (isFormulaCard(card)) {
          const sourceCard = cards.find((c) => c.id === card.sourceCardId);
          const sourceMatrix =
            sourceCard && isMatrixCard(sourceCard)
              ? matrices.get(sourceCard.sources[sourceCard.activeSource]?.matrixId ?? -1)
              : undefined;
          const sourceColumnNames = sourceMatrix
            ? sourceMatrix.columns().map((c) => c.annotation || c.posName)
            : [];
          return (
            <FormulaCard
              key={card.id}
              card={card}
              resultMatrix={matrices.get(card.resultMatrixId)}
              sourceColumnNames={sourceColumnNames}
              active={active}
              closeBlocked={closeBlocked}
              onActivate={() => bringToFront(card.id)}
              onClose={() => handleClose(card.id)}
              onCloseBlocked={() => reportBlocked(card.id)}
            />
          );
        }

        return (
          <ChartCard
            key={card.id}
            card={card}
            active={active}
            closeBlocked={closeBlocked}
            onActivate={() => bringToFront(card.id)}
            onClose={() => handleClose(card.id)}
            onCloseBlocked={() => reportBlocked(card.id)}
          />
        );
      }),
    [
      cards,
      selectedId,
      matrices,
      dependencies,
      bringToFront,
      handleClose,
      reportBlocked,
      addChartCard,
      addFormulaCard,
      select,
    ],
  );

  // ── drag & drop ──────────────────────────────────────────────────────

  const onDragEnter = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const onDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const onDrop = (event: React.DragEvent) => {
    dragDepth.current = 0;
    setDragActive(false);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    onFilesDropped(Array.from(files));
  };

  return (
    <div
      className={`canvas${dragActive ? ' canvas--dragging' : ''}`}
      ref={canvasRef}
      onContextMenu={onContextMenu}
      onClick={(event) => {
        // Clicking the bare canvas clears the selection (deselects the active card).
        if (event.target === canvasRef.current) select(null);
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ConnectionLayer
        cards={cards}
        selectedId={selectedId}
        blockedCardId={blockedCardId}
        blockNonce={blockNonce}
      />

      {cards.length === 0 ? (
        <EmptyState onNewTable={onNewTable} dragActive={dragActive} />
      ) : null}

      <div className="canvas__cards">{renderedCards}</div>

      {dragActive ? <div className="canvas__drop-hint">{t('empty.hint')}</div> : null}
    </div>
  );
}

export { CardShell };
