/**
 * Card canvas — an unbounded, pannable plane.
 *
 * Owns the pannable world layer, the viewport-fixed connection overlay, the empty-state
 * affordance, the right-click "new table" gesture, file drops and the pan gestures.
 * All geometry lives in the store; this component only orchestrates.
 *
 * Two nested coordinate spaces:
 *
 *   .canvas        the visible viewport — clips, never moves
 *   .canvas__world the card plane — carries `translate(-view.x, -view.y) scale(zoom)`
 *                  and is the
 *                  origin every anchor measurement is taken against (cardMetrics), so
 *                  panning cancels out of the geometry instead of having to be applied
 *                  twice.
 *
 * The plane is sized from the cards themselves, so it grows without bound as a workflow
 * spreads out; `PLANE_PAD` keeps a margin of empty space beyond the furthest card so
 * there is always somewhere further to drag a card to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  MAX_ZOOM,
  MIN_ZOOM,
  invalidateLayout,
  setCanvasElement,
  setCanvasZoom,
  setWorldElement,
} from '../cardMetrics.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { isChartCard, isFormulaCard, isMatrixCard } from '../types.ts';
import { ConnectionLayer } from '../ConnectionLayer.tsx';
import { CardShell } from './CardShell.tsx';
import { ChartCard } from './ChartCard.tsx';
import { FormulaCard } from './FormulaCard.tsx';
import { EmptyState } from './EmptyState.tsx';
import { MatrixCard } from './MatrixCard.tsx';

/** Empty space kept beyond the furthest card, in px: room to keep building outward. */
const PLANE_PAD = 900;

/** Pointer travel before a press on the bare canvas counts as a pan, not a click. */
const PAN_THRESHOLD = 4;

/** Dot-grid pitch of the canvas backdrop, in px. Drives the pan-parallax offset below. */
const GRID_SIZE = 22;

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
  const view = useWorkspace((s) => s.view);
  const setView = useWorkspace((s) => s.setView);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const dragDepth = useRef(0);

  // ── plane geometry ──────────────────────────────────────────────────

  /**
   * The plane spans every card plus a margin. Deriving it from the cards (rather than
   * fixing a size) is what makes it unbounded: dragging a card outward grows the plane,
   * which lets it be dragged further still on the next frame.
   */
  const plane = useMemo(() => {
    let width = viewportSize.width;
    let height = viewportSize.height;
    for (const card of cards) {
      width = Math.max(width, card.x + card.width);
      height = Math.max(height, card.y + card.height);
    }
    return { width: width + PLANE_PAD, height: height + PLANE_PAD };
  }, [cards, viewportSize]);

  const maxPan = useMemo(
    () => ({
      // The plane is measured in plane px; the view is stored in screen px because the
      // pan is applied *after* the scale. So the plane's rendered extent is `size * zoom`.
      x: Math.max(0, plane.width * view.zoom - viewportSize.width),
      y: Math.max(0, plane.height * view.zoom - viewportSize.height),
    }),
    [plane, viewportSize, view.zoom],
  );

  /** Keep the view inside the plane and the zoom inside its limits. */
  const clampView = useCallback(
    (candidate: { x: number; y: number; zoom: number }) => ({
      x: Math.min(Math.max(0, candidate.x), maxPan.x),
      y: Math.min(Math.max(0, candidate.y), maxPan.y),
      zoom: Math.min(Math.max(candidate.zoom, MIN_ZOOM), MAX_ZOOM),
    }),
    [maxPan],
  );

  /** Pan by a screen-px delta, clamped against the *current* sizes. */
  const panByClamped = useCallback(
    (dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return;
      const current = useWorkspace.getState().view;
      const next = clampView({ x: current.x + dx, y: current.y + dy, zoom: current.zoom });
      if (next.x !== current.x || next.y !== current.y) setView(next);
    },
    [clampView, setView],
  );

  /**
   * On-screen pitch of the backdrop dots.
   *
   * The grid belongs to the plane, so it scales with the zoom — but the raw 22px pitch
   * turns into a 2.2px moiré mesh at 10% and into sparse holes at 300%. Doubling/halving
   * the *plane* step keeps the rendered pitch inside a readable band while the dots still
   * travel and scale with the cards, which is what makes the plane feel anchored.
   */
  const grid = useMemo(() => {
    let step = GRID_SIZE;
    while (step * view.zoom < 8) step *= 2;
    while (step * view.zoom > 44) step /= 2;
    const pitch = step * view.zoom;
    return {
      size: `${pitch}px ${pitch}px`,
      position: `${-view.x % pitch}px ${-view.y % pitch}px`,
    };
  }, [view.x, view.y, view.zoom]);

  /**
   * Zoom the whole workbench around a point, so whatever is under the cursor stays put.
   *
   * The world layer is CSS-transformed, so *everything* inside it scales together — card
   * faces, ECharts plots (SVG, so still vector and still crisp), table text, toolbars.
   * Holding the anchor point fixed is what makes wheel zoom feel like a canvas rather than
   * a slider that drags the work away from the cursor.
   */
  const zoomAt = useCallback(
    (factor: number, clientX: number, clientY: number) => {
      const element = canvasRef.current;
      if (!element) return;
      const current = useWorkspace.getState().view;
      const nextZoom = Math.min(Math.max(current.zoom * factor, MIN_ZOOM), MAX_ZOOM);
      if (nextZoom === current.zoom) return;

      const rect = element.getBoundingClientRect();
      const cursor = { x: clientX - rect.left, y: clientY - rect.top };
      // Plane point under the cursor: screen = plane*zoom - pan, solved for plane.
      const anchor = {
        x: (cursor.x + current.x) / current.zoom,
        y: (cursor.y + current.y) / current.zoom,
      };
      const maxX = Math.max(0, plane.width * nextZoom - viewportSize.width);
      const maxY = Math.max(0, plane.height * nextZoom - viewportSize.height);
      setView({
        zoom: nextZoom,
        x: Math.min(Math.max(0, anchor.x * nextZoom - cursor.x), maxX),
        y: Math.min(Math.max(0, anchor.y * nextZoom - cursor.y), maxY),
      });
    },
    [plane, viewportSize, setView],
  );

  // Removing the furthest card (or resizing the window) shrinks the plane; without this
  // the stored pan could sit past the new edge and the view would show empty space.
  useEffect(() => {
    const clamped = clampView(view);
    if (clamped.x !== view.x || clamped.y !== view.y || clamped.zoom !== view.zoom) {
      setView(clamped);
    }
  }, [view, clampView, setView]);

  // ── measurement registration ────────────────────────────────────────

  useEffect(() => {
    setCanvasElement(canvasRef.current);
    setWorldElement(worldRef.current);
    return () => {
      setCanvasElement(null);
      setWorldElement(null);
    };
  }, []);

  // Publish the zoom before anything measures: `getBoundingClientRect` reports scaled
  // pixels, and every anchor converts back to plane units through this value.
  useEffect(() => {
    setCanvasZoom(view.zoom);
  }, [view.zoom]);

  // Keep anchors fresh when the viewport itself changes size.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const measure = () =>
      setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    window.addEventListener('resize', invalidateLayout);
    return () => window.removeEventListener('resize', invalidateLayout);
  }, []);

  // ── pan gestures ────────────────────────────────────────────────────
  //
  // Wheel/trackpad scrolling, middle-button drag and space+left drag all pan; a plain
  // left drag on the bare canvas pans too, but only after the pointer travels far enough
  // to rule out a click (clicking the background still clears the selection).
  // Deliberately *not* right-drag: the right button already opens the "new table" menu,
  // and the project's own connection/gesture conventions must not be re-purposed.

  const pan = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);

  const beginPan = useCallback((event: React.PointerEvent) => {
    const element = canvasRef.current;
    if (!element) return;
    pan.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
    setIsPanning(true);
    // Optional: jsdom (used by the DOM tests) does not implement pointer capture, and a
    // missing capture only costs us events that leave the element mid-drag.
    element.setPointerCapture?.(event.pointerId);
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    // React portals bubble synthetic events through the *React* tree, so a context menu
    // portaled to <body> arrives here even though it is nowhere near the canvas. The DOM
    // path is the only honest test: without it, pressing a menu item was classified as
    // "bare canvas", the canvas captured the pointer, and the item's click never fired —
    // the menu just stayed open. Caught by the browser probe, not by the unit tests.
    const path = event.nativeEvent.composedPath?.() ?? [];
    if (!canvasRef.current || !path.includes(canvasRef.current)) return;

    const onCard = (event.target as HTMLElement).closest('.card') !== null;
    // Middle button pans from anywhere, space+left pans from anywhere.
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault();
      beginPan(event);
      return;
    }
    // Plain left press on the bare canvas: armed, promoted to a pan once it moves.
    if (event.button === 0 && !onCard) beginPan(event);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = pan.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.lastX;
    const dy = event.clientY - state.lastY;
    if (!state.moved) {
      if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
      state.moved = true;
    }
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    panByClamped(-dx, -dy);
  };

  const endPan = (event: React.PointerEvent) => {
    const state = pan.current;
    if (!state || state.pointerId !== event.pointerId) return;
    pan.current = null;
    setIsPanning(false);
    canvasRef.current?.releasePointerCapture?.(event.pointerId);
  };

  // Wheel needs a non-passive native listener to be able to preventDefault.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const overCard = (event.target as HTMLElement | null)?.closest('.card') !== null;
      // A wheel over a card belongs to the card — a 10 000-row table must stay scrollable
      // and the chart's dataZoom must keep working — unless the user holds Ctrl/Cmd. That
      // modifier is also what a trackpad pinch sends, so pinch-to-zoom keeps working and
      // gives a way to zoom without moving the pointer off a card.
      if (overCard && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      // Exponential so each wheel notch is a constant *ratio*: zooming feels the same at
      // 20% and at 300%, which a linear addend would not.
      zoomAt(Math.pow(1.0015, -event.deltaY * unit), event.clientX, event.clientY);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const isTextTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      const tag = element.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      if (isTextTarget(event.target)) return;
      setSpaceHeld(true);
      // Stop the page from scrolling — but leave buttons alone so Space still activates
      // whatever has focus.
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag !== 'BUTTON' && tag !== 'A') event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    // A window that loses focus mid-pan must not leave the canvas stuck in pan mode.
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
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
          // Which of this table's columns feed a chart. The connection overlay paints
          // *behind* the cards, so the "this column is in use" marker must be a style on the
          // header cell rather than an SVG rectangle.
          //
          // Marked for the selected chart, and also for every chart that depends on this
          // table when the table itself is selected — otherwise selecting the table (the
          // case where its lines turn red) left nothing at all identifying the linked
          // column.
          const sourceColumns: number[] = [];
          const dependents = dependencies.getDependents(card.id);
          const tableSelected = selectedId === card.id;
          if (source) {
            for (const entry of cards) {
              if (!isChartCard(entry)) continue;
              const relevant = entry.id === selectedId || (tableSelected && dependents.includes(entry.id));
              if (!relevant) continue;
              for (const chartSource of entry.config.sources) {
                if (chartSource.matrixId === source.matrixId) sourceColumns.push(chartSource.columnIndex);
              }
              const xAxis = entry.config.xAxisSource;
              if (xAxis && xAxis.matrixId === source.matrixId) sourceColumns.push(xAxis.columnIndex);
            }
          }
          return (
            <MatrixCard
              key={card.id}
              card={card}
              matrix={source ? matrices.get(source.matrixId) : undefined}
              sourceColumns={sourceColumns}
              active={active}
              closeBlocked={closeBlocked}
              onActivate={() => bringToFront(card.id)}
              onClose={() => handleClose(card.id)}
              onCloseBlocked={() => reportBlocked(card.id)}
              onOpenChart={(columnIndex, type) => {
                const id = addChartCard(card.id, columnIndex, type);
                if (id !== null) select(id);
                return id;
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
      className={`canvas${dragActive ? ' canvas--dragging' : ''}${
        isPanning ? ' canvas--panning' : spaceHeld ? ' canvas--pan-ready' : ''
      }`}
      ref={canvasRef}
      // Parallax the dot grid by the pan so the backdrop belongs to the plane rather than
      // to the window. Offsetting the fixed viewport's background keeps this free — the
      // alternative (a plane-sized background layer) would be rasterised at plane size.
      style={{ backgroundSize: grid.size, backgroundPosition: grid.position }}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onClick={(event) => {
        // Clicking the bare canvas clears the selection (deselects the active card) —
        // unless that "click" was the tail of a pan.
        if (event.target !== canvasRef.current) return;
        if (pan.current?.moved) return;
        select(null);
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
        view={view}
      />

      <div
        className="canvas__world"
        ref={worldRef}
        style={{
          width: plane.width,
          height: plane.height,
          transform: `translate(${-view.x}px, ${-view.y}px) scale(${view.zoom})`,
        }}
      >
        <div className="canvas__cards">{renderedCards}</div>
      </div>

      {cards.length === 0 ? (
        <EmptyState onNewTable={onNewTable} dragActive={dragActive} />
      ) : null}

      {dragActive ? (
        <div className="canvas__drop-hint">{t('empty.dropHint')}</div>
      ) : null}
    </div>
  );
}

export { CardShell };