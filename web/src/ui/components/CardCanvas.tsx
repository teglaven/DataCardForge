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
import { FormulaCard, type ResolvedInput } from './FormulaCard.tsx';
import { EmptyState } from './EmptyState.tsx';
import { MatrixCard } from './MatrixCard.tsx';

/** Empty space kept beyond the furthest card, in px: room to keep building outward. */
const PLANE_PAD = 900;

/** Pointer travel before a press on the bare canvas counts as a pan, not a click. */
const PAN_THRESHOLD = 4;

/** Dot-grid pitch of the canvas backdrop, in px. Drives the pan-parallax offset below. */
const GRID_SIZE = 22;

/**
 * Press targets that own their own click and therefore must not arm a pan.
 *
 * Arming the pan captures the pointer on the canvas, and a captured pointer delivers its
 * `pointerup` to the capturing element. The browser then dispatches the resulting `click`
 * to the nearest common ancestor of press and release — the canvas — so the control's own
 * click handler never runs. That is exactly how the empty-state「打开数据文件…」button came to
 * do nothing at all: no picker, no error, no toast. Drag & drop and the canvas context menu
 * never travel through that click, which is why they kept working.
 */
const INTERACTIVE =
  'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"], .empty-state';

/**
 * Whether a press lands on a control (or on the empty-state overlay) rather than on the
 * bare canvas. Exported as a pure helper because jsdom does not implement pointer capture:
 * a DOM-level test cannot reproduce the retargeted click, only the classification.
 */
export function isInteractivePress(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE) !== null;
}

/**
 * The data card under a drop, or `null` when the drop landed on bare canvas.
 *
 * A file dropped on a data card means "this card should hold this file" — replacing its
 * data — while a drop on empty canvas keeps creating a new card. The hit test is a pure
 * function for the same reason `isInteractivePress` is: jsdom cannot synthesise a
 * trustworthy drag gesture, so the real gesture is covered by the browser smoke test.
 */
export function matrixCardDropTargetId(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest('.card--matrix[data-card-id]');
  if (!(element instanceof HTMLElement)) return null;
  const cardId = Number(element.dataset.cardId);
  return Number.isFinite(cardId) ? cardId : null;
}

interface CardCanvasProps {
  onNewTable: () => void;
  onFilesDropped: (files: File[]) => void;
  /** Files dropped *on* a data card: replace that card's data instead of creating one. */
  onFilesDroppedOnCard: (cardId: number, files: File[]) => void;
  /** The card's「替换文件…」control: pick one file and replace the shown one. */
  onPickReplaceFile: (cardId: number) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

export function CardCanvas({
  onNewTable,
  onFilesDropped,
  onFilesDroppedOnCard,
  onPickReplaceFile,
  onContextMenu,
}: CardCanvasProps) {
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
  const repointOffers = useWorkspace((s) => s.repointOffers);
  const applyRepoint = useWorkspace((s) => s.applyRepoint);
  const dismissRepoint = useWorkspace((s) => s.dismissRepoint);
  const applyRepointsForOwner = useWorkspace((s) => s.applyRepointsForOwner);
  const renameOutputColumn = useWorkspace((s) => s.renameOutputColumn);
  const addRelationEnumCard = useWorkspace((s) => s.addRelationEnumCard);
  const setColumnContract = useWorkspace((s) => s.setColumnContract);
  const view = useWorkspace((s) => s.view);
  const setView = useWorkspace((s) => s.setView);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  /** Data card currently under a file drag; it would be replaced on drop. */
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
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
  // A plain left press that lands on a control is *not* armed: the capture below would
  // retarget that control's `pointerup` — and with it its `click` — to the canvas, which
  // is why pressing the empty-state file button used to do nothing. Middle-button and
  // space+left still pan from anywhere, controls included.
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
    // Never armed over a control: `beginPan` captures the pointer, and that capture is
    // what turned a press on the file button into a canvas click (see `INTERACTIVE`).
    if (event.button === 0 && !onCard && !isInteractivePress(event.target)) beginPan(event);
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
  //
  // It listens in the **capture** phase, and that is load-bearing: a wheel over a chart
  // plot is claimed by ECharts' inside `dataZoom`, which calls `preventDefault()` *and*
  // `stopPropagation()` for every wheel — Ctrl held or not (`RoamController` →
  // `eventTool.stop`). A bubble-phase listener here therefore never saw a Ctrl+wheel over
  // a chart, so the modifier documented below ("zoom without moving the pointer off a
  // card") silently did nothing there: the chart's axes zoomed instead of the workspace.
  // Capturing reaches the event before the plot does.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const overCard = (event.target as HTMLElement | null)?.closest('.card') !== null;
      // A plain wheel over a card belongs to the card — a 10 000-row table must stay
      // scrollable and the chart's dataZoom must keep working — unless the user holds
      // Ctrl/Cmd. That modifier is also what a trackpad pinch sends, so pinch-to-zoom
      // keeps working and gives a way to zoom without moving the pointer off a card.
      if (overCard && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // Stop it only for the gesture just taken: `preventDefault` alone would still let
      // the card's own handler run, so one wheel would zoom the chart's axes *and* the
      // canvas. The early return above keeps a plain wheel entirely the card's.
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      // Exponential so each wheel notch is a constant *ratio*: zooming feels the same at
      // 20% and at 300%, which a linear addend would not.
      zoomAt(Math.pow(1.0015, -event.deltaY * unit), event.clientX, event.clientY);
    };
    element.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => element.removeEventListener('wheel', onWheel, { capture: true });
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
              dropTarget={dropTargetId === card.id}
              onActivate={() => bringToFront(card.id)}
              onClose={() => handleClose(card.id)}
              onCloseBlocked={() => reportBlocked(card.id)}
              onReplaceFile={() => onPickReplaceFile(card.id)}
              onOpenChart={(columnIndex, type) => {
                const id = addChartCard(card.id, columnIndex, type);
                if (id !== null) select(id);
                return id;
              }}
              onOpenFormula={() => {
                const id = addFormulaCard(card.id);
                if (id !== null) select(id);
              }}
              onOpenRelationEnum={(column) => {
                const id = addRelationEnumCard(card.id, column);
                if (id !== null) select(id);
              }}
            />
          );
        }

        if (isFormulaCard(card)) {
          // v2: the card reads explicit matrices (its own `inputs`), not "whatever file the
          // source table happens to show". Resolve every port for the left zone.
          const resolveInput = (entry: (typeof card.inputs)[number]): ResolvedInput => {
            const matrix = matrices.get(entry.target.matrixId);
            const owner = cards.find((other) => other.id === entry.target.cardId);
            // A data card names the file; a function card's output has no file name, so it
            // says which card it came from (the same rule the store uses to resolve owners).
            const sourceName =
              owner && isMatrixCard(owner)
                ? owner.sources.find((source) => source.matrixId === entry.target.matrixId)?.name
                : owner && isFormulaCard(owner)
                  ? t('formula.outputLabel', { n: owner.id })
                  : undefined;
            const column = entry.target.type === 'cell' ? entry.target.column : undefined;
            const label = [
              sourceName ?? `#${entry.target.matrixId}`,
              column !== undefined
                ? (matrix?.columnLabel(column) || matrix?.column(column).posName || `col ${column + 1}`)
                : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return {
              portId: entry.portId,
              mode: entry.target.type === 'cell' ? 'cell' : 'matrix',
              label,
              matrixId: entry.target.matrixId,
              column,
              // Every column of the bound matrix, so a cell port can be re-bound from the
              // card itself ("choose the column" used to be a creation-time decision).
              columns: matrix
                ? matrix.columns().map((c, index) => c.annotation || c.posName || `Pos.${index + 1}`)
                : [],
              rows: matrix?.rowCount() ?? 0,
              cols: matrix?.columnCount() ?? 0,
              missing: !matrix,
            };
          };
          const resolvedInputs = card.inputs.map(resolveInput);
          // Column labels of the first matrix input, for the "available columns" hint.
          const firstMatrix = card.inputs.find((entry) => entry.target.type === 'matrix');
          const sourceMatrix = firstMatrix ? matrices.get(firstMatrix.target.matrixId) : undefined;
          const sourceColumnNames = sourceMatrix
            ? sourceMatrix.columns().map((c) => c.annotation || c.posName)
            : [];
          const offer = repointOffers.find((entry) => entry.cardId === card.id) ?? null;
          const batch = offer
            ? repointOffers.filter((entry) => entry.ownerCardId === offer.ownerCardId).length
            : 0;
          return (
            <FormulaCard
              key={card.id}
              card={card}
              resultMatrix={matrices.get(card.displayMatrixId)}
              sourceColumnNames={sourceColumnNames}
              inputs={resolvedInputs}
              repoint={offer}
              repointBatch={batch}
              onApplyRepoint={() => applyRepoint(card.id)}
              onDismissRepoint={() => dismissRepoint(card.id)}
              onApplyAllRepoints={() => {
                if (offer) applyRepointsForOwner(offer.ownerCardId);
              }}
              onRenameOutputColumn={(index, name) => renameOutputColumn(card.id, index, name)}
              onSetColumnContract={(columns) => setColumnContract(card.id, columns)}
              onOpenFunction={() => {
                // Chain: this card's output becomes the next card's explicit input.
                const id = addFormulaCard(card.id);
                if (id !== null) select(id);
              }}
              onOpenChart={(columnIndex, type) => {
                // The output side of the dataflow: a chart drawn from a function card's
                // result is an ordinary chart whose source is that card's output table.
                const id = addChartCard(card.id, columnIndex, type);
                if (id !== null) select(id);
                return id;
              }}
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
      repointOffers,
      applyRepoint,
      dismissRepoint,
      applyRepointsForOwner,
      renameOutputColumn,
      addRelationEnumCard,
      setColumnContract,
      dependencies,
      bringToFront,
      handleClose,
      reportBlocked,
      addChartCard,
      addFormulaCard,
      select,
      dropTargetId,
      onPickReplaceFile,
    ],
  );

  // ── drag & drop ──────────────────────────────────────────────────────

  /**
   * Hint text for the current drag: empty canvas → import, data card → replace. A
   * multi-file card is named by its file count, because a drop replaces the whole set
   * (naming only the active file would promise a narrower change than the one that happens).
   */
  const dropHint = useMemo(() => {
    if (dropTargetId === null) return t('empty.dropHint');
    const card = cards.find((entry) => entry.id === dropTargetId);
    if (!card || !isMatrixCard(card)) return t('empty.dropHint');
    return card.sources.length > 1
      ? t('empty.dropHintReplaceMultiple', { n: card.sources.length })
      : t('empty.dropHintReplace', { name: card.sources[card.activeSource]?.name ?? '' });
  }, [cards, dropTargetId, t]);

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
    // Tracked here, not in a per-card listener: one hit test keeps the drop path and the
    // highlight in agreement (and avoids nested dragenter/leave depth counters).
    const targetId = matrixCardDropTargetId(event.target);
    setDropTargetId((current) => (current === targetId ? current : targetId));
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDragActive(false);
      setDropTargetId(null);
    }
  };

  const onDrop = (event: React.DragEvent) => {
    dragDepth.current = 0;
    setDragActive(false);
    setDropTargetId(null);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    const targetId = matrixCardDropTargetId(event.target);
    if (targetId !== null) onFilesDroppedOnCard(targetId, Array.from(files));
    else onFilesDropped(Array.from(files));
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
        dependencies={dependencies}
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

      {dragActive ? <div className="canvas__drop-hint">{dropHint}</div> : null}
    </div>
  );
}

export { CardShell };