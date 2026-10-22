/**
 * Workspace store.
 *
 * Holds everything the Qt `MainWindow` + `CardRegistry` used to own: the set of
 * cards, their geometry and stacking order, the parsed matrices behind each matrix
 * card, the dependency graph, and the transient status line.
 *
 * Two invariants carry over from the C++ implementation:
 *   1. A matrix card whose matrix still has dependents cannot be closed
 *      (`DependencyGraph::hasDependents`) — the UI blinks the offending lines.
 *   2. Switching the active file inside a matrix card pushes fresh column data into
 *      every dependent chart; if the column no longer exists the line keeps its old
 *      data rather than disappearing.
 */
import { create } from 'zustand';

import {
  MAX_ZOOM,
  MIN_ZOOM,
  canvasSize,
  getCanvasZoom,
  viewportRectInWorld,
} from './cardMetrics.ts';
import { DependencyGraph } from '../core/DependencyGraph.ts';
import { MatrixData } from '../core/MatrixData.ts';
import { DEFAULT_SMOOTHING, type SmoothingOptions } from '../core/Smoothing.ts';
import { defaultChartConfig, type ChartConfig, type ChartSource } from '../charts/chartModel.ts';
import { chartTypeDef, minimumColumns, type ChartTypeId } from '../charts/chartTypes.ts';
import { lineColor } from '../charts/palette.ts';
// B-plan (docs/decisions/2026-10-17-backend-owns-compute.md): no numeric compute lives in
// the browser any more. `core/expression.ts` is NOT imported here — parsing, compiling and
// evaluating formulas are the backend's job; the frontend only ships formula *text*.
import {
  identityKey,
  isChartCard,
  isFormulaCard,
  isMatrixCard,
  type CardModel,
  type ChartCardModel,
  type FormulaCardModel,
  type MatrixCardModel,
  type MatrixSnapshot,
  type FileIdentity,
  type NodeStatus,
  type WorkspaceSnapshot,
} from './types.ts';
import { translatorFor, detectLocale, type Locale } from './i18n.ts';
import { BackendClient, type NodeEvent, type PortBindingDto } from '../backend/client.ts';

export { lineColor };

/**
 * Compute-backend availability (B-plan). Unreachable is a VISIBLE state with a reason —
 * the UI renders a banner from this; nothing ever falls back to local compute silently.
 */
export interface BackendStatus {
  state: 'unknown' | 'online' | 'offline' | 'mismatch';
  build?: string;
  protocol?: number;
  /** Structured detail for the banner (code-style, not user prose). */
  error?: string;
}

/**
 * Display label for a column: the file's annotation when present, otherwise `Pos.N`.
 * Shared by every place that materialises a `ChartSource`.
 */
function columnLabel(column: { posName: string; annotation: string }): string {
  return column.annotation !== '' ? `${column.posName} ${column.annotation}` : column.posName;
}

/**
 * Minimum card footprint, in px.
 *
 * The height is not arbitrary: a chart card stacks a 31px toolbar, a 48px plot floor and a
 * footer that measures 65px at comfortable widths but **117px** once the chip and smoothing
 * rows wrap at the 280px minimum width, plus a 31px title bar and borders — 227px in the
 * worst case. At the old 180px the smoothing row landed 80px *below* the card edge with no
 * way to reach it; 240px leaves the plot ~59px in that worst case.
 */
export const MIN_CARD_WIDTH = 280;
export const MIN_CARD_HEIGHT = 240;

/** Deliberately coarse epsilon: float noise from drag/resize must not re-render. */
const GEOM_EPSILON = 0.01;

/** Keep a new card at least this far from the origin of the card plane. */
const CARD_MARGIN = 8;

/** Down-right step used while the preferred spot is taken. */
const CARD_CASCADE_STEP = 28;
const CARD_CASCADE_TRIES = 24;

/**
 * Place a new card near `preferred`, on the unbounded card plane.
 *
 * The previous version clamped into the *viewport*, which is precisely why a workflow
 * could never grow past one screenful: a chart opened from a table parked near the right
 * edge was folded back on top of its parent (and the Qt-era bug it guarded against —
 * a card created off-plane while the status bar announced success — is now impossible,
 * because the plane grows with the cards instead of ending at the window edge).
 *
 * A spot the user cannot see is *not* pulled back into view: folding a chart away from
 * the table it was opened from would stretch its connection line across the plane and
 * destroy the spatial story the canvas is telling. The view is moved instead (see
 * `revealView`), which is what "create something, then look at it" means everywhere else.
 * `occupied` lets the position cascade while it overlaps an existing card, so a burst of
 * new cards never stacks invisibly at one point.
 */
function placeOnPlane(
  preferred: { x: number; y: number },
  size: { width: number; height: number },
  occupied: Array<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number } {
  let x = preferred.x;
  let y = preferred.y;

  const overlaps = (cx: number, cy: number) =>
    occupied.some(
      (c) =>
        cx < c.x + c.width + CARD_MARGIN &&
        cx + size.width + CARD_MARGIN > c.x &&
        cy < c.y + c.height + CARD_MARGIN &&
        cy + size.height + CARD_MARGIN > c.y,
    );

  for (let i = 0; i < CARD_CASCADE_TRIES && overlaps(x, y); i += 1) {
    x += CARD_CASCADE_STEP;
    y += CARD_CASCADE_STEP;
  }

  // The plane extends without bound right and down, but not into negative space: cards
  // are laid out from the origin and react-rnd's `bounds="parent"` keeps them there.
  return { x: Math.max(CARD_MARGIN, x), y: Math.max(CARD_MARGIN, y) };
}

/**
 * Where the view has to move for `bounds` to be fully visible, given the current pan.
 *
 * Panning rather than repositioning keeps new cards next to their parent — the whole
 * point of drawing connections at all. Returns `current` unchanged when the card is
 * already in sight, or when nothing can be measured (SSR, unit tests without a DOM).
 */
function revealView(
  bounds: { x: number; y: number; width: number; height: number },
  current: { x: number; y: number; zoom: number },
): { x: number; y: number; zoom: number } {
  const visible = viewportRectInWorld();
  if (visible.width <= 0 || visible.height <= 0) return current;

  const margin = 24;
  let dx = 0;
  let dy = 0;
  if (bounds.x < visible.left + margin) {
    dx = bounds.x - margin - visible.left;
  } else if (bounds.x + bounds.width > visible.left + visible.width - margin) {
    dx = bounds.x + bounds.width + margin - (visible.left + visible.width);
  }
  if (bounds.y < visible.top + margin) {
    dy = bounds.y - margin - visible.top;
  } else if (bounds.y + bounds.height > visible.top + visible.height - margin) {
    dy = bounds.y + bounds.height + margin - (visible.top + visible.height);
  }
  if (dx === 0 && dy === 0) return current;
  // The plane delta is in plane px; `view` is stored in screen px (the translate runs after
  // the scale), so it has to be multiplied by the zoom.
  return {
    x: Math.max(0, current.x + dx * current.zoom),
    y: Math.max(0, current.y + dy * current.zoom),
    zoom: current.zoom,
  };
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

interface WorkspaceState {
  cards: CardModel[];
  /** Parsed matrices by id. Kept outside the cards so charts can share them. */
  matrices: Map<number, MatrixData>;
  /**
   * Byte identity (`size:lastModified`) -> matrix id, so re-opening the *same bytes*
   * reuses a parse. Keyed on content, never on file name: two different files routinely
   * share a name (`export.csv` overwritten daily), and returning the older parse for the
   * newer bytes would silently plot stale measurements.
   */
  matrixIdByIdentity: Map<string, number>;
  selectedId: number | null;
  dependencies: DependencyGraph;
  /** Card that should blink because a close was blocked. */
  blockedCardId: number | null;
  /**
   * Increments on every refused close. The blink animation keys off this so that
   * blocking the same card twice in a row restarts the flash.
   */
  blockNonce: number;
  toast: Toast | null;
  locale: Locale;
  nextCardId: number;
  nextMatrixId: number;
  /**
   * View of the infinite canvas: pan in **screen** px plus a zoom factor. The world layer
   * is drawn at `translate(-view.x, -view.y) scale(view.zoom)` — pan is applied *after*
   * the scale, which is why it stays in screen px while every card coordinate is in plane
   * px. The plane itself is unbounded (it grows with the cards), so this is the only piece
   * of view state that has to be remembered; clamping against the plane/viewport sizes
   * happens in `CardCanvas`, the only place that can measure them.
   */
  view: { x: number; y: number; zoom: number };

  // ── card lifecycle ──────────────────────────────────────────────────
  addMatrixCard: (
    entries: Array<{ name: string; matrix: MatrixData; identity?: FileIdentity }>,
  ) => number;
  addChartCard: (matrixCardId: number, columnIndex: number, chartType?: ChartTypeId) => number | null;
  removeCard: (id: number) => boolean;
  closeAllCards: () => void;
  setBounds: (id: number, bounds: { x: number; y: number; width: number; height: number }) => void;
  bringToFront: (id: number) => void;
  select: (id: number | null) => void;
  /** Move the canvas view by a screen-px delta (already clamped by the caller). */
  panBy: (dx: number, dy: number) => void;
  setView: (view: { x: number; y: number; zoom: number }) => void;
  /** Frame every card again — the escape hatch after panning off into empty space. */
  resetView: () => void;

  // ── matrix card behaviour ───────────────────────────────────────────
  setActiveSource: (cardId: number, index: number) => void;
  /** Edit a single cell in the active matrix of a matrix card. */
  editCell: (cardId: number, row: number, col: number, value: number) => void;
  /** Mark a matrix card as editable (non-file-backed cards). */
  setEditable: (cardId: number, editable: boolean) => void;

  // ── chart card behaviour ────────────────────────────────────────────
  setSmoothing: (cardId: number, options: SmoothingOptions) => void;
  /** Change the chart type, growing the source list if the new type needs more columns. */
  setChartType: (cardId: number, type: ChartTypeId) => void;
  /** Patch presentation options (log axis, dual axis, fit line, bins, …). */
  setChartConfig: (cardId: number, patch: Partial<ChartConfig>) => void;
  addChartSource: (cardId: number, matrixId: number, columnIndex: number) => void;
  removeChartSource: (cardId: number, matrixId: number, columnIndex: number) => void;

  // ── formula card behaviour ──────────────────────────────────────────
  /** Create a formula card that reads from a source matrix card. */
  addFormulaCard: (sourceCardId: number) => number | null;
  /** Add or update a formula column. Registers / patches the backing compute node. */
  setFormula: (cardId: number, index: number, name: string, expression: string) => void;
  /** Remove a formula column. Deletes its compute node and releases its result matrix. */
  removeFormula: (cardId: number, index: number) => void;
  /** Re-send every formula of a card to the backend so it recomputes. */
  recomputeFormula: (cardId: number) => void;

  // ── view helpers ────────────────────────────────────────────────────
  tileCards: (viewportWidth: number, viewportHeight: number) => void;
  cascadeCards: () => void;

  // ── misc ────────────────────────────────────────────────────────────
  setLocale: (locale: Locale) => void;
  /** Flag a card as "cannot close", restarting the connection blink. */
  blockCard: (id: number) => void;
  showToast: (kind: Toast['kind'], message: string) => void;
  clearToast: () => void;

  // ── compute backend (B-plan: docs/decisions/2026-10-17-backend-owns-compute.md) ──
  backend: BackendStatus;
  /** Handshake with the compute backend; result is stored in `backend`, never silent. */
  connectBackend: () => Promise<void>;
  /** Register a freshly parsed matrix server-side; records the node/matrix id mapping. */
  registerMatrixWithBackend: (name: string, columns: MatrixSnapshot['columns']) => Promise<number | null>;
  /** Server matrix id for a local matrix id, once registered (null while offline). */
  backendMatrixId: (localMatrixId: number) => number | null;
  /** Apply one backend node event: update the indicator and refresh the display cache. */
  applyNodeEvent: (event: NodeEvent) => void;
  /**
   * Subscribe to the backend's long-poll event stream. Idempotent: re-arming replaces any
   * live subscription. Every formula card's four-state light and result table are driven
   * from these events — the browser performs no computation of its own.
   */
  startBackendEventLoop: () => void;
  /** Tear down the event subscription (used by tests and on shutdown). */
  stopBackendEventLoop: () => void;

  // ── persistence ─────────────────────────────────────────────────────
  toSnapshot: () => WorkspaceSnapshot;
  loadSnapshot: (snapshot: WorkspaceSnapshot) => void;
  /** Return the store to its initial state (used by tests and "close all"). */
  reset: () => void;
}

let toastCounter = 0;

/** Singleton transport client + local→server matrix id map (B-plan registration). */
const backendClient = new BackendClient();
const backendMatrixIds = new Map<number, number>();

/** server result-matrix id → local display-cache matrix id (one per formula column). */
const backendResultLocalIds = new Map<number, number>();
/** Highest backend event `seq` already applied; the long-poll resumes after it. */
let lastEventSeq = 0;
/** The single live event subscription. Re-armed whenever the backend comes back online. */
let eventLoopAbort: AbortController | null = null;

/** Cancel any live event subscription (module-level so store actions can call it). */
function stopEventLoop(): void {
  if (eventLoopAbort) {
    eventLoopAbort.abort();
    eventLoopAbort = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < GEOM_EPSILON;
}

/**
 * Column label the backend resolves a formula identifier against.
 *
 * The C++ engine matches identifiers case-insensitively on the column's *label* — the
 * annotation when present, otherwise `Pos.N` (`Matrix::label`) — so this mirrors exactly
 * what the old local evaluator used as its variable names. It is not compute: it only
 * tells the store which source columns a formula actually mentions, so each node binds
 * precisely those ports instead of the whole table under an arbitrary alias.
 */
function sourceColumnLabel(column: { posName: string; annotation: string }): string {
  return column.annotation !== '' ? column.annotation : column.posName;
}

/** Case-insensitive "does this expression reference `name`?" — text inspection only. */
function referencesName(expression: string, name: string): boolean {
  const lower = expression.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(name.toLowerCase(), from);
    if (at < 0) return false;
    const before = at === 0 ? '' : expression[at - 1];
    const after = expression[at + name.length] ?? '';
    // Reject substring hits inside a longer identifier (annotation `tempC` vs `temp`).
    if (!/[A-Za-z0-9_.]/.test(before) && !/[A-Za-z0-9_.]/.test(after)) return true;
    from = at + 1;
  }
}

/** The bindings one formula needs: every referenced source column, bound in matrix mode. */
function buildPortBindings(
  expression: string,
  sourceBackendMatrixId: number,
  columns: ReadonlyArray<{ posName: string; annotation: string }>,
): PortBindingDto[] {
  const bindings: PortBindingDto[] = [];
  for (const column of columns) {
    const label = sourceColumnLabel(column);
    if (label === '') continue;
    if (referencesName(expression, label)) {
      bindings.push({ varName: label, mode: 'matrix', sourceMatrixId: sourceBackendMatrixId });
    }
  }
  return bindings;
}

/**
 * Materialise a decoded DCM1 frame into a read-only display matrix.
 *
 * This is a pure shape conversion — no arithmetic. Non-finite values arrive unchanged
 * (IEEE 754 over the wire) and keep rendering as `—`.
 */
function frameToMatrixData(window: {
  rows?: number;
  data?: Float64Array[];
  names?: string[];
}): MatrixData {
  const matrix = new MatrixData();
  const columns = window.data ?? [];
  const names = window.names ?? [];
  for (let c = 0; c < columns.length; ++c) {
    const col = columns[c];
    const label = names[c] ?? `Pos.${c + 1}`;
    const space = label.startsWith('Pos.') ? label.indexOf(' ') : -1;
    const posName = space > 0 ? label.slice(0, space) : label;
    const annotation = space > 0 ? label.slice(space + 1) : '';
    matrix.appendColumn(posName, Array.from(col));
    matrix.setColumnAnnotation(matrix.columnCount() - 1, annotation);
  }
  return matrix;
}

/** A card's nodes once a formula column is added or removed (index-aligned with formulas). */
function resizeNodeStatuses(
  statuses: Array<NodeStatus | null>,
  length: number,
): Array<NodeStatus | null> {
  const next = statuses.slice(0, length);
  while (next.length < length) next.push(null);
  return next;
}

/**
 * Make restored cards safe for the B-plan model.
 *
 * Snapshots saved before formula cards were backed by compute nodes have no `nodes` field;
 * older ones may even carry pre-computed result data. Restoring must never resurrect local
 * computation, so every formula card comes back with empty node slots — the sources are
 * re-registered on demand and results flow from the backend again. Non-formula cards pass
 * through untouched.
 */
function normalizeRestoredCards(cards: CardModel[]): CardModel[] {
  return cards.map((card) =>
    isFormulaCard(card) ? { ...card, nodes: resizeNodeStatuses(card.nodes ?? [], card.formulas.length) } : card,
  );
}

/**
 * Register / patch one backend compute node per formula column of a card.
 *
 * The mapping is deliberately **one node per formula column**: the protocol gives a node a
 * single `formula`, while a formula card holds several output columns. Index alignment lets
 * an edit PATCH the right node and a removed column DELETE its node (releasing its result
 * matrix). Each node binds exactly the source columns its expression references, in matrix
 * mode, against the source card's *active* server matrix.
 *
 * Fire-and-forget like registration: never blocks the UI; a genuinely unreachable backend
 * flips the banner (contract 1 — 降级必须可见), it does not fall back to local compute.
 */
async function syncFormulaNodes(cardId: number): Promise<void> {
  const state = useWorkspace.getState();
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || !isFormulaCard(card)) return;

  const sourceCard = state.cards.find((c) => c.id === card.sourceCardId);
  if (!sourceCard || !isMatrixCard(sourceCard)) return;
  const activeSource = sourceCard.sources[sourceCard.activeSource];
  if (!activeSource) return;
  const sourceMatrix = state.matrices.get(activeSource.matrixId);
  if (!sourceMatrix) return;

  // The node must read the *server-side* copy of the active matrix. If it is not registered
  // yet (offline at load time), there is nothing authoritative to bind to — leave the nodes
  // unregistered and let the offline banner carry the failure. Never compute locally.
  const sourceBackendId = backendMatrixIds.get(activeSource.matrixId);
  if (sourceBackendId === undefined) return;

  const columns = sourceMatrix.columns();
  for (let i = 0; i < card.formulas.length; ++i) {
    const formula = card.formulas[i];
    const inputs = buildPortBindings(formula.expression, sourceBackendId, columns);
    const existing = card.nodes[i] ?? null;

    const send = existing
      ? backendClient.patchNode(existing.nodeId, { formula: formula.expression, inputs })
      : backendClient.createNode(inputs, formula.expression);

    const result = await send;
    if (!result.ok) {
      if (result.code === 'backendUnavailable') {
        useWorkspace.setState({ backend: { state: 'offline', error: result.code } });
      } else {
        // A structured refusal (e.g. cycle) is surfaced on the node so the light goes red
        // and the i18n message renders — visible, never silent.
        markNodeError(cardId, i, result.code ?? 'internalError', {});
      }
      continue;
    }

    const nodeId = result.nodeId!;
    const resultMatrixId =
      result.resultMatrixId ?? (existing ? existing.resultMatrixId : -1);
    recordResultMapping(resultMatrixId, cardId, i);
    applyNodeSnapshot(cardId, i, {
      nodeId,
      resultMatrixId,
      state: result.state ?? 'dirty',
    });
    if (result.state === 'done') void pullResultIntoCache(nodeId, resultMatrixId);
  }
}

/** Remember which local display-cache column a server result matrix feeds. */
function recordResultMapping(resultMatrixId: number, cardId: number, index: number): void {
  if (resultMatrixId >= 0) backendResultLocalIds.set(resultMatrixId, localColumnId(cardId, index));
}

/**
 * Stable local id for one formula column's per-column display cache.
 *
 * Negative so it can never collide with a source-matrix id (those start at 1). Keeping a
 * slot per column is what lets several single-column node results merge into one card
 * table without clobbering each other.
 */
function localColumnId(cardId: number, index: number): number {
  return -(cardId * 1_000 + index + 1);
}

/** Write a node's status into the card model (drives the four-state light). */
function applyNodeSnapshot(cardId: number, index: number, status: NodeStatus): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) => {
      if (card.id !== cardId || !isFormulaCard(card)) return card;
      const nodes = resizeNodeStatuses(card.nodes, card.formulas.length);
      nodes[index] = status;
      return { ...card, nodes };
    }),
  }));
}

/** Mark a column's node as errored with a structured code (no result pull attempted). */
function markNodeError(
  cardId: number,
  index: number,
  code: string,
  params: Record<string, unknown>,
): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) => {
      if (card.id !== cardId || !isFormulaCard(card)) return card;
      const nodes = resizeNodeStatuses(card.nodes, card.formulas.length);
      const prev = nodes[index];
      nodes[index] = {
        nodeId: prev?.nodeId ?? -1,
        resultMatrixId: prev?.resultMatrixId ?? -1,
        state: 'error',
        code,
        params,
      };
      return { ...card, nodes };
    }),
  }));
}

/** Find the (cardId, columnIndex) a node id belongs to. */
function locateNode(nodeId: number): { cardId: number; index: number; resultMatrixId: number } | null {
  for (const card of useWorkspace.getState().cards) {
    if (!isFormulaCard(card)) continue;
    for (let i = 0; i < card.nodes.length; ++i) {
      const n = card.nodes[i];
      if (n && n.nodeId === nodeId) {
        return { cardId: card.id, index: i, resultMatrixId: n.resultMatrixId };
      }
    }
  }
  return null;
}

/** Pull a done node's result window and write it into the card's display cache. */
async function pullResultIntoCache(nodeId: number, resultMatrixId: number): Promise<void> {
  if (resultMatrixId < 0) return;
  const frame = await backendClient.nodeResult(resultMatrixId);
  if (!frame.ok) {
    if (frame.code === 'backendUnavailable') {
      useWorkspace.setState({ backend: { state: 'offline', error: frame.code } });
    }
    return;
  }
  const matrix = frameToMatrixData(frame);
  const located = locateNode(nodeId);
  if (!located) return;
  // Store this column's freshly pulled values in its own cache slot first, then rebuild the
  // merged card table from every column's current slot — order preserved, no clobbering.
  useWorkspace.setState((state) => {
    const matrices = new Map(state.matrices);
    matrices.set(localColumnId(located.cardId, located.index), matrix);
    const card = state.cards.find((c) => c.id === located.cardId);
    if (!card || !isFormulaCard(card)) return { matrices };
    const merged = new MatrixData();
    for (let i = 0; i < card.formulas.length; ++i) {
      const cached = matrices.get(localColumnId(card.id, i));
      const name = card.formulas[i].name;
      if (cached && cached.columnCount() > 0) {
        const col = cached.column(0);
        merged.appendColumn(name, col.data.slice());
        merged.setColumnAnnotation(merged.columnCount() - 1, col.annotation);
      } else {
        merged.appendColumn(name, []);
      }
    }
    matrices.set(card.resultMatrixId, merged);
    return { matrices };
  });
}


export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Highest z currently in use, so new cards land on top. */
  const topZ = (): number =>
    get().cards.reduce((max, card) => Math.max(max, card.z), 0);

  /**
   * Bring a freshly created card into view by panning, not by moving the card.
   *
   * Split out of the placement helpers because only the store may write the view, and
   * because every "new card" path (table, chart, formula) wants the same follow-up.
   */
  const revealCard = (bounds: { x: number; y: number; width: number; height: number }): void => {
    const current = get().view;
    const next = revealView(bounds, current);
    if (next.x !== current.x || next.y !== current.y) set({ view: next });
  };

  /**
   * Push fresh column data into every chart that reads data from `matrixCardId`.
   *
   * Dependencies are registered against the *card* (chart → matrix card) rather than
   * the parsed matrix id, because a matrix card owns several matrices when it holds
   * several files. Switching the active file therefore re-points each dependent line
   * at the newly active matrix — the behaviour the Qt frontend wanted but could not
   * express, since its `SourceRef` captured a matrix id.
   *
   * A line keeps its previous data when the new file no longer has that column.
   */
  const refreshDependentCharts = (matrixCardId: number): void => {
    const state = get();
    const matrixCard = state.cards.find((c) => c.id === matrixCardId);
    if (!matrixCard || !isMatrixCard(matrixCard)) return;

    const active = matrixCard.sources[matrixCard.activeSource];
    if (!active) return;
    const activeMatrix = state.matrices.get(active.matrixId);
    if (!activeMatrix) return;

    const matrixIds = new Set(matrixCard.sources.map((source) => source.matrixId));
    const dependentIds = new Set(state.dependencies.getDependents(matrixCardId));
    if (dependentIds.size === 0) return;

    /**
     * Re-point one attached column at the newly active matrix.
     *
     * A column that vanished in the new file keeps its previous values so the curve does
     * not silently disappear — the behaviour the Qt frontend settled on.
     */
    const rePoint = (source: ChartSource): ChartSource => {
      if (source.columnIndex >= activeMatrix.columnCount()) {
        return { ...source, matrixId: active.matrixId };
      }
      const column = activeMatrix.column(source.columnIndex);
      return {
        ...source,
        matrixId: active.matrixId,
        raw: column.data.slice(),
        label: columnLabel(column),
      };
    };

    set(() => {
      const cards = state.cards.map((card) => {
        if (!dependentIds.has(card.id)) return card;

        if (isChartCard(card)) {
          let changed = false;
          const sources = card.config.sources.map((source) => {
            // Only sources that actually read this card's data are re-pointed.
            if (!matrixIds.has(source.matrixId)) return source;
            changed = true;
            return rePoint(source);
          });

          // The explicit X axis is a second, independent reference to a column of this
          // card's matrix. Leaving it alone made a file switch plot the *new* Y values
          // against the *previous* file's X values.
          let xAxisSource = card.config.xAxisSource;
          if (xAxisSource && matrixIds.has(xAxisSource.matrixId)) {
            changed = true;
            // A vanished X column falls back to the row index rather than keeping stale
            // values: the dropdown's label and the drawn axis must not disagree.
            xAxisSource =
              xAxisSource.columnIndex >= activeMatrix.columnCount()
                ? null
                : rePoint(xAxisSource);
          }

          return changed
            ? { ...card, config: { ...card.config, sources, xAxisSource } }
            : card;
        }

        // A formula card used to be recomputed here in the browser. Under the B-plan it is
        // now a pure view: switching the source file re-points its compute nodes at the new
        // backend matrix (see `recomputeFormula`), and the fresh numbers arrive through the
        // event stream + window fetch — never through local evaluation.
        return card;
      });

      return { cards };
    });

    // Formula dependents follow the newly active file by re-binding their nodes server-side.
    for (const dependentId of dependentIds) {
      const card = get().cards.find((c) => c.id === dependentId);
      if (card && isFormulaCard(card) && card.sourceCardId === matrixCardId) {
        get().recomputeFormula(dependentId);
      }
    }
  };

  return {
    cards: [],
    matrices: new Map(),
    matrixIdByIdentity: new Map(),
    selectedId: null,
    dependencies: new DependencyGraph(),
    blockedCardId: null,
    blockNonce: 0,
    toast: null,
    locale: detectLocale(),
    nextCardId: 1,
    nextMatrixId: 1,
    view: { x: 0, y: 0, zoom: 1 },

    // ── card lifecycle ────────────────────────────────────────────────

    addMatrixCard(entries) {
      if (entries.length === 0) return -1;
      const state = get();
      const cardId = state.nextCardId;
      const z = topZ() + 1;

      // Reuse an already-parsed matrix only when the *bytes* match; allocate a new id
      // otherwise. An entry without an identity (a programmatically built table, or a
      // restored snapshot) is never shared — it gets its own matrix.
      const matrices = new Map(state.matrices);
      const matrixIdByIdentity = new Map(state.matrixIdByIdentity);
      let nextMatrixId = state.nextMatrixId;
      const sources: Array<{ name: string; matrixId: number }> = [];

      for (const entry of entries) {
        const key = entry.identity ? identityKey(entry.identity) : null;
        if (key !== null) {
          const existing = matrixIdByIdentity.get(key);
          if (existing !== undefined && matrices.has(existing)) {
            sources.push({ name: entry.name, matrixId: existing });
            continue;
          }
        }
        const matrixId = nextMatrixId++;
        matrices.set(matrixId, entry.matrix);
        if (key !== null) matrixIdByIdentity.set(key, matrixId);
        sources.push({ name: entry.name, matrixId });

        // Register server-side too (B-plan: the backend holds the authoritative copy).
        // Fire-and-forget: file loading must never wait on the network; a failed
        // registration flips `backend` to offline and the banner appears.
        void (async () => {
          const columns = entry.matrix.columns().map((c) => ({
            posName: c.posName,
            annotation: c.annotation,
            data: c.data,
          }));
          const id = await get().registerMatrixWithBackend(entry.name, columns);
          if (id !== null) backendMatrixIds.set(matrixId, id);
        })();
      }

      // Cascade placement, so stacked cards do not land exactly on top of each other.
      // Routed through placeOnPlane so a table opened while the view is panned away
      // still lands where the user is looking.
      const offset = (state.cards.length % 8) * 28;
      const matrixSize = { width: 640, height: 420 };
      const matrixSpot = placeOnPlane(
        { x: 24 + offset, y: 24 + offset },
        matrixSize,
        state.cards,
      );
      const card: MatrixCardModel = {
        kind: 'matrix',
        id: cardId,
        title: '',
        ...matrixSpot,
        width: matrixSize.width,
        height: matrixSize.height,
        z,
        createdAt: Date.now(),
        sources,
        activeSource: 0,
        readOnly: true,
      };

      set({
        cards: [...state.cards, card],
        matrices,
        matrixIdByIdentity,
        nextCardId: cardId + 1,
        nextMatrixId,
        selectedId: cardId,
      });
      revealCard({ ...matrixSpot, ...matrixSize });
      return cardId;
    },

    addChartCard(matrixCardId, columnIndex, chartType) {
      const state = get();
      const matrixCard = state.cards.find((c) => c.id === matrixCardId);
      if (!matrixCard || !isMatrixCard(matrixCard)) return null;

      const source = matrixCard.sources[matrixCard.activeSource];
      if (!source) return null;
      const matrix = state.matrices.get(source.matrixId);
      if (!matrix) return null;
      if (columnIndex < 0 || columnIndex >= matrix.columnCount()) return null;

      const type: ChartTypeId = chartType ?? 'line';
      const def = chartTypeDef(type);

      // Attach the clicked column first, then as many following columns as the type
      // wants (a scatter needs an X and a Y, a heatmap wants a whole set).
      const wanted = Math.max(def.defaultColumnCount, minimumColumns(type));
      const sources: ChartSource[] = [];
      for (let offset = 0; offset < wanted; ++offset) {
        const index = columnIndex + offset;
        if (index >= matrix.columnCount()) break;
        const column = matrix.column(index);
        sources.push({
          matrixId: source.matrixId,
          columnIndex: index,
          label: columnLabel(column),
          raw: column.data.slice(),
        });
      }
      if (sources.length < minimumColumns(type)) return null;

      const cardId = state.nextCardId;
      const chartSize = { width: 560, height: 400 };
      // Beside the table it was opened from, so the connection line stays short.
      const chartSpot = placeOnPlane(
        { x: matrixCard.x + matrixCard.width + 32, y: matrixCard.y + 24 },
        chartSize,
        state.cards,
      );
      const card: ChartCardModel = {
        kind: 'chart',
        id: cardId,
        title: '',
        // Offset from the source card so the new chart is visibly its child, clamped so it
        // always lands on the card plane.
        ...chartSpot,
        width: chartSize.width,
        height: chartSize.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        config: defaultChartConfig(type, sources),
        smoothing: { ...DEFAULT_SMOOTHING },
      };

      // The chart depends on the matrix *card*: this is what makes "switch file in the
      // table, chart follows" work even though each file is a separate matrix.
      // Guarded against loops — once FunctionCard chains cards together, a chart could
      // otherwise end up depending on itself through a longer path.
      const cycle = state.dependencies.addDependency(cardId, matrixCardId);
      if (cycle) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return null;
      }

      set({
        cards: [...state.cards, card],
        nextCardId: cardId + 1,
        selectedId: cardId,
      });
      revealCard({ ...chartSpot, ...chartSize });
      return cardId;
    },

    removeCard(id) {
      const state = get();
      const card = state.cards.find((c) => c.id === id);
      if (!card) return true;

      // A matrix card that still feeds a chart must not disappear under it.
      if (isMatrixCard(card)) {
        if (state.dependencies.hasDependents(id)) {
          set({
            blockedCardId: id,
            blockNonce: state.blockNonce + 1,
            selectedId: id,
          });
          return false;
        }
      }

      const cards = state.cards.filter((c) => c.id !== id);
      const matrices = new Map(state.matrices);
      const matrixIdByIdentity = new Map(state.matrixIdByIdentity);

      if (isMatrixCard(card)) {
        for (const source of card.sources) {
          // Drop the parse only when no remaining card refers to it. The identity cache
          // is pruned by scanning it for the id that just died — keying on name would
          // delete the wrong entry whenever two files share a label.
          const stillUsed = cards.some(
            (c) => isMatrixCard(c) && c.sources.some((s) => s.matrixId === source.matrixId),
          );
          if (!stillUsed) {
            matrices.delete(source.matrixId);
            for (const [key, mid] of matrixIdByIdentity) {
              if (mid === source.matrixId) matrixIdByIdentity.delete(key);
            }
            // Release the server-side copy too, otherwise the backend grows without
            // bound as cards are opened and closed. The map entry is dropped first so a
            // later reconnect cannot hand out an id the server no longer has.
            const backendId = backendMatrixIds.get(source.matrixId);
            if (backendId !== undefined) {
              backendMatrixIds.delete(source.matrixId);
              void backendClient.deleteMatrix(backendId);
            }
          }
        }
      } else if (isFormulaCard(card)) {
        // A formula card owns its derived matrix outright; no other card can reference it,
        // so it must not be left behind in the map. Neither may its per-column cache slots.
        matrices.delete(card.resultMatrixId);
        for (let i = 0; i < card.formulas.length; ++i) matrices.delete(localColumnId(card.id, i));
        // Delete every backing node server-side. `DELETE /api/nodes/{id}` also drops the
        // node's result matrix, so this is what releases the compute graph on close — and
        // keeps the local→server id maps from handing out ids the server no longer has.
        for (const status of card.nodes) {
          if (!status || status.nodeId < 0) continue;
          backendResultLocalIds.delete(status.resultMatrixId);
          void backendClient.deleteNode(status.nodeId).then((result) => {
            if (!result.ok && result.code === 'backendUnavailable') {
              set({ backend: { state: 'offline', error: result.code } });
            }
          });
        }
      }

      state.dependencies.removeAllDependencies(id);

      set({
        cards,
        matrices,
        matrixIdByIdentity,
        selectedId: state.selectedId === id ? null : state.selectedId,
        blockedCardId: state.blockedCardId === id ? null : state.blockedCardId,
      });
      return true;
    },

    closeAllCards() {
      set((state) => ({
        cards: [],
        matrices: new Map(),
        matrixIdByIdentity: new Map(),
        selectedId: null,
        blockedCardId: null,
        blockNonce: state.blockNonce + 1,
        dependencies: new DependencyGraph(),
      }));
    },

    setBounds(id, bounds) {
      set((state) => {
        const index = state.cards.findIndex((c) => c.id === id);
        if (index < 0) return state;
        const card = state.cards[index];
        const width = Math.max(MIN_CARD_WIDTH, bounds.width);
        const height = Math.max(MIN_CARD_HEIGHT, bounds.height);
        if (
          nearlyEqual(card.x, bounds.x) &&
          nearlyEqual(card.y, bounds.y) &&
          nearlyEqual(card.width, width) &&
          nearlyEqual(card.height, height)
        ) {
          return state; // unchanged — avoids a render loop with the drag handler
        }
        const next = state.cards.slice();
        next[index] = { ...card, x: bounds.x, y: bounds.y, width, height };
        return { ...state, cards: next };
      });
    },

    bringToFront(id) {
      set((state) => {
        const top = state.cards.reduce((max, c) => Math.max(max, c.z), 0);
        const index = state.cards.findIndex((c) => c.id === id);
        if (index < 0) return state;
        // Already on top and already selected -> nothing to do.
        if (state.cards[index].z === top && state.selectedId === id) return state;
        const next = state.cards.slice();
        next[index] = { ...state.cards[index], z: top + 1 };
        return { ...state, cards: next, selectedId: id };
      });
    },

    select(id) {
      set({ selectedId: id });
    },

    // ── matrix card behaviour ─────────────────────────────────────────

    setActiveSource(cardId, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isMatrixCard(card)) return;
      if (index < 0 || index >= card.sources.length || index === card.activeSource) return;

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isMatrixCard(c) ? { ...c, activeSource: index } : c,
        ),
      });

      // Charts that read this card must pick up the new file's data.
      refreshDependentCharts(cardId);
    },

    editCell(cardId, row, col, value) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isMatrixCard(card)) return;
      const source = card.sources[card.activeSource];
      if (!source) return;
      const matrix = state.matrices.get(source.matrixId);
      if (!matrix) return;
      matrix.setCell(row, col, value);
      // Mutating in place is intentional: MatrixData is a mutable model and charts read
      // from it directly. The store reference does not change, so React won't re-render
      // the table — but VirtualTable reads cell values on each render cycle triggered by
      // scroll or other interactions. For an immediate visual update we bump the card.
      set({
        cards: state.cards.map((c) =>
          c.id === cardId ? { ...c } : c,
        ),
      });
      refreshDependentCharts(cardId);

      // B-plan: the backend holds the authoritative copy, so an edit must reach it.
      // Fire-and-forget like registration — editing never blocks on the network; only a
      // genuinely unreachable backend flips the banner.
      const backendId = backendMatrixIds.get(source.matrixId);
      if (backendId !== undefined) {
        void backendClient.patchCells(backendId, [{ row, col, value }]).then((result) => {
          if (!result.ok && result.code === 'backendUnavailable') {
            set({ backend: { state: 'offline', error: result.code } });
          }
        });
      }
    },

    setEditable(cardId, editable) {
      set((state) => ({
        cards: state.cards.map((c) =>
          c.id === cardId && isMatrixCard(c) ? { ...c, readOnly: !editable } : c,
        ),
      }));
    },

    // ── chart card behaviour ──────────────────────────────────────────

    setSmoothing(cardId, options) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isChartCard(card) ? { ...card, smoothing: options } : card,
        ),
      }));
    },

    setChartType(cardId, type) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isChartCard(card)) return;

      // Switching to a type that consumes more columns may require growing the source
      // list: pull further columns from the same matrix so the chart can draw at once.
      const def = chartTypeDef(type);
      const needed = Math.max(def.defaultColumnCount, minimumColumns(type));
      let sources = card.config.sources.slice();

      if (sources.length < needed) {
        const owner = state.cards.find(
          (c) =>
            isMatrixCard(c) &&
            c.sources.some((s) => s.matrixId === sources[0]?.matrixId),
        );
        if (owner && isMatrixCard(owner)) {
          const matrixId = sources[0]?.matrixId ?? owner.sources[owner.activeSource]?.matrixId;
          const matrix = matrixId !== undefined ? state.matrices.get(matrixId) : undefined;
          if (matrix) {
            // Continue from the columns already attached rather than restarting at 0:
            // for a `pairs` type the first source is the X axis, so pulling column 0 in
            // would silently make an unrelated column the Y of a chart the user built
            // from column 5.
            const used = new Set(sources.map((source) => source.columnIndex));
            const anchor = Math.min(...used);
            const append = (index: number) => {
              const column = matrix.column(index);
              sources.push({
                matrixId,
                columnIndex: index,
                label: columnLabel(column),
                raw: column.data.slice(),
              });
            };
            for (let index = anchor; index < matrix.columnCount() && sources.length < needed; ++index) {
              if (!used.has(index)) append(index);
            }
            // Only if the matrix ends before the requirement is met do we wrap around.
            for (let index = 0; index < anchor && sources.length < needed; ++index) {
              if (!used.has(index)) append(index);
            }
          }
        }
      }

      set((current) => ({
        cards: current.cards.map((entry) =>
          entry.id === cardId && isChartCard(entry)
            ? { ...entry, config: { ...entry.config, type, sources } }
            : entry,
        ),
      }));
    },

    setChartConfig(cardId, patch) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isChartCard(card)
            ? { ...card, config: { ...card.config, ...patch } }
            : card,
        ),
      }));
    },

    addChartSource(cardId, matrixId, columnIndex) {
      set((state) => ({
        cards: state.cards.map((card) => {
          if (card.id !== cardId || !isChartCard(card)) return card;
          // Never attach the same column twice.
          if (
            card.config.sources.some(
              (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
            )
          ) {
            return card;
          }
          const matrix = state.matrices.get(matrixId);
          if (!matrix || columnIndex < 0 || columnIndex >= matrix.columnCount()) return card;
          const column = matrix.column(columnIndex);
          const source: ChartSource = {
            matrixId,
            columnIndex,
            label: columnLabel(column),
            raw: column.data.slice(),
          };
          return {
            ...card,
            config: { ...card.config, sources: [...card.config.sources, source] },
          };
        }),
      }));
    },

    removeChartSource(cardId, matrixId, columnIndex) {
      set((state) => ({
        cards: state.cards.map((card) => {
          if (card.id !== cardId || !isChartCard(card)) return card;
          const sources = card.config.sources.filter(
            (source) => !(source.matrixId === matrixId && source.columnIndex === columnIndex),
          );
          // A chart with no columns has nothing to draw; keep at least one. Also refuse to
          // drop below what the *current type* needs: silently degrading a scatter to
          // "needs at least 2 columns" destroys work the user cannot undo.
          const floor = Math.max(1, minimumColumns(card.config.type));
          if (sources.length < floor) return card;
          // The X axis may have pointed at the column just removed.
          const xAxisSource =
            card.config.xAxisSource &&
            card.config.xAxisSource.matrixId === matrixId &&
            card.config.xAxisSource.columnIndex === columnIndex
              ? null
              : card.config.xAxisSource;
          return {
            ...card,
            config: { ...card.config, sources, xAxisSource },
          };
        }),
      }));
    },

    // ── formula card behaviour ────────────────────────────────────────

    addFormulaCard(sourceCardId) {
      const state = get();
      const sourceCard = state.cards.find((c) => c.id === sourceCardId);
      if (!sourceCard || !isMatrixCard(sourceCard)) return null;
      const source = sourceCard.sources[sourceCard.activeSource];
      if (!source) return null;
      const sourceMatrix = state.matrices.get(source.matrixId);
      if (!sourceMatrix) return null;

      const cardId = state.nextCardId;
      const resultMatrixId = state.nextMatrixId;

      // Start with one empty formula referencing the first column. The identifier must be
      // the label the backend resolves against — annotation when present, else Pos.N — not
      // the raw posName: `Pos.1 * 2` fails on a table whose first column is annotated `A`.
      const firstColLabel = sourceMatrix.columnCount() > 0 ? sourceColumnLabel(sourceMatrix.column(0)) : 'A';
      const formulas = [{ name: `${firstColLabel} × 2`, expression: `${firstColLabel} * 2` }];

      // The result matrix starts as an EMPTY display cache. It is filled only once the
      // backend reports a node `done` and we pull its result window — the browser computes
      // nothing (docs/decisions/2026-10-17-backend-owns-compute.md).
      const matrices = new Map(state.matrices);
      matrices.set(resultMatrixId, new MatrixData());

      const formulaSize = { width: 520, height: 380 };
      const formulaSpot = placeOnPlane(
        { x: sourceCard.x + 40, y: sourceCard.y + sourceCard.height + 32 },
        formulaSize,
        state.cards,
      );
      const card: FormulaCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        ...formulaSpot,
        width: formulaSize.width,
        height: formulaSize.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        sourceCardId,
        formulas,
        resultMatrixId,
        nodes: [null],
      };

      state.dependencies.addDependency(cardId, sourceCardId);

      set({
        cards: [...state.cards, card],
        matrices,
        nextCardId: cardId + 1,
        nextMatrixId: resultMatrixId + 1,
        selectedId: cardId,
      });
      revealCard({ ...formulaSpot, ...formulaSize });

      void syncFormulaNodes(cardId);
      return cardId;
    },

    setFormula(cardId, index, name, expression) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;

      const formulas = card.formulas.slice();
      if (index >= 0 && index < formulas.length) {
        formulas[index] = { name, expression };
      } else {
        formulas.push({ name, expression });
      }

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c)
            ? { ...c, formulas, nodes: resizeNodeStatuses(c.nodes, formulas.length) }
            : c,
        ),
      });

      // Push the change to the backend: existing columns PATCH their node, a new column
      // registers one. Results arrive asynchronously through the event stream.
      void syncFormulaNodes(cardId);
    },

    removeFormula(cardId, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      if (card.formulas.length <= 1) return; // keep at least one

      const removed = card.nodes[index];
      const formulas = card.formulas.filter((_, i) => i !== index);

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c)
            ? { ...c, formulas, nodes: resizeNodeStatuses(c.nodes, formulas.length) }
            : c,
        ),
      });

      // Release the deleted column's node; removing it drops its result matrix server-side.
      if (removed) {
        void backendClient.deleteNode(removed.nodeId).then((result) => {
          if (!result.ok && result.code === 'backendUnavailable') {
            set({ backend: { state: 'offline', error: result.code } });
          }
        });
      }
    },

    recomputeFormula(cardId) {
      // "Recompute" means "re-send the definitions to the backend"; the browser never
      // evaluates. Each node's inputs are re-bound to the source card's *active* matrix so
      // a file switch cascades through the server, then results flow back via events.
      void syncFormulaNodes(cardId);
    },

    // ── view helpers ──────────────────────────────────────────────────

    tileCards(viewportWidth, viewportHeight) {
      const state = get();
      const count = state.cards.length;
      if (count === 0) return;

      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      const gap = 12;
      const pad = 12;
      const cellWidth = Math.max(MIN_CARD_WIDTH, (viewportWidth - pad * 2 - gap * (cols - 1)) / cols);
      const cellHeight = Math.max(
        MIN_CARD_HEIGHT,
        (viewportHeight - pad * 2 - gap * (rows - 1)) / rows,
      );

      // Anchor the grid to the visible rectangle: on an unbounded plane, tiling from a
      // fixed origin would rearrange the cards somewhere the user is not looking.
      const view = viewportRectInWorld();
      const cards = state.cards.map((card, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        return {
          ...card,
          x: Math.max(0, view.left) + pad + col * (cellWidth + gap),
          y: Math.max(0, view.top) + pad + row * (cellHeight + gap),
          width: cellWidth,
          height: cellHeight,
        };
      });
      set({ cards });
    },

    cascadeCards() {
      const state = get();
      const view = viewportRectInWorld();
      const originX = Math.max(0, view.left);
      const originY = Math.max(0, view.top);
      const cards = state.cards.map((card, index) => ({
        ...card,
        x: originX + 24 + index * 28,
        y: originY + 24 + index * 28,
        z: index + 1,
      }));
      set({ cards });
    },

    // ── canvas view (infinite plane) ───────────────────────────────────

    panBy(dx, dy) {
      const { view } = get();
      // Clamping lives in CardCanvas: only the DOM knows the plane and viewport sizes.
      set({ view: { x: view.x + dx, y: view.y + dy, zoom: view.zoom } });
    },

    setView(view) {
      set({ view });
    },

    resetView() {
      const { cards } = get();
      if (cards.length === 0) {
        set({ view: { x: 0, y: 0, zoom: 1 } });
        return;
      }
      // Nominal visible box, in screen px: `canvasSize()` reports plane units (Tile/Cascade
      // place cards with it), so multiply the zoom back in.
      const zoom = getCanvasZoom();
      const box = canvasSize();
      const screen = { width: box.width * zoom, height: box.height * zoom };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const card of cards) {
        minX = Math.min(minX, card.x);
        minY = Math.min(minY, card.y);
        maxX = Math.max(maxX, card.x + card.width);
        maxY = Math.max(maxY, card.y + card.height);
      }
      // Zoom-to-fit: "where did my work go" deserves an answer that actually shows the
      // work, so the fit shrinks the view when the cards span more than one screenful —
      // but never zooms in past 100%, which would look like a bug rather than a feature.
      const padding = 48;
      const fit = Math.min(
        screen.width > 0 ? screen.width / (maxX - minX + padding) : 1,
        screen.height > 0 ? screen.height / (maxY - minY + padding) : 1,
        1,
      );
      const nextZoom = Math.min(Math.max(fit, MIN_ZOOM), MAX_ZOOM);
      // Centre on the cards rather than jumping to the origin.
      set({
        view: {
          zoom: nextZoom,
          x: Math.max(0, ((minX + maxX) / 2) * nextZoom - screen.width / 2),
          y: Math.max(0, ((minY + maxY) / 2) * nextZoom - screen.height / 2),
        },
      });
    },

    // ── misc ──────────────────────────────────────────────────────────

    setLocale(locale) {
      set({ locale });
    },

    blockCard(id) {
      set((state) => ({
        blockedCardId: id,
        blockNonce: state.blockNonce + 1,
        selectedId: id,
      }));
    },

    showToast(kind, message) {
      set({ toast: { id: ++toastCounter, kind, message } });
    },

    clearToast() {
      set({ toast: null });
    },

    // ── compute backend ───────────────────────────────────────────────

    backend: { state: 'unknown' },
    connectBackend: async () => {
      const info = await backendClient.hello();
      if (info.ok) {
        set({ backend: { state: 'online', build: info.build, protocol: info.protocol } });
        // The event stream is the only way results reach the browser; re-arm it whenever we
        // (re)connect so a reconnect after an outage resumes pushing node states.
        get().startBackendEventLoop();
      } else if (info.error?.startsWith('protocol-mismatch')) {
        stopEventLoop();
        set({ backend: { state: 'mismatch', error: info.error } });
      } else {
        stopEventLoop();
        set({ backend: { state: 'offline', error: info.error ?? 'unreachable' } });
      }
    },

    registerMatrixWithBackend: async (name, columns) => {
      const result = await backendClient.registerMatrix(name, columns);
      if (!result.ok || result.matrixId === undefined) {
        set({ backend: { state: 'offline', error: result.code ?? 'unreachable' } });
        return null;
      }
      return result.matrixId;
    },

    backendMatrixId: (localMatrixId) => backendMatrixIds.get(localMatrixId) ?? null,

    applyNodeEvent(event) {
      // Matrix-level events (no nodeId) carry no per-node state to mirror here.
      if (event.nodeId === undefined || !event.state) return;
      if (event.seq > lastEventSeq) lastEventSeq = event.seq;
      const located = locateNode(event.nodeId);
      if (!located) return;
      const { cardId, index, resultMatrixId } = located;
      applyNodeSnapshot(cardId, index, {
        nodeId: event.nodeId,
        resultMatrixId,
        state: event.state,
        code: event.code,
        params: event.params,
      });
      // A finished computation is the trigger to pull the numbers — the display cache is
      // refreshed from the window endpoint, never from a local evaluation.
      if (event.state === 'done') void pullResultIntoCache(event.nodeId, resultMatrixId);
    },

    startBackendEventLoop() {
      stopEventLoop();
      const controller = new AbortController();
      eventLoopAbort = controller;
      void (async () => {
        while (!controller.signal.aborted) {
          const events = await backendClient.events(lastEventSeq, controller.signal);
          if (controller.signal.aborted) break;
          for (const event of events) get().applyNodeEvent(event);
          // `events()` resolves empty on timeout or transport failure; a small pause keeps
          // a dead backend from spinning the loop while the offline banner stays visible.
          if (events.length === 0) await sleep(250);
        }
      })();
    },

    stopBackendEventLoop() {
      stopEventLoop();
    },

    // ── persistence ───────────────────────────────────────────────────

    toSnapshot() {
      const state = get();
      const matrices: MatrixSnapshot[] = [];

      // Resolve each matrix's display name from the cards that actually reference it.
      // The identity cache cannot serve this purpose — it is keyed by bytes, not by label,
      // and a name lookup here was what previously degraded to `#id` when two cards shared
      // a file name. A matrix nothing references still gets a stable placeholder.
      const nameForMatrix = (matrixId: number): string => {
        for (const card of state.cards) {
          if (!isMatrixCard(card)) continue;
          const source = card.sources.find((s) => s.matrixId === matrixId);
          if (source) return source.name;
        }
        return `#${matrixId}`;
      };

      for (const [id, matrix] of state.matrices) {
        matrices.push({
          id,
          name: nameForMatrix(id),
          columns: matrix.columns().map((col) => ({
            posName: col.posName,
            annotation: col.annotation,
            data: col.data,
          })),
        });
      }
      return {
        version: 1,
        savedAt: new Date().toISOString(),
        cards: state.cards,
        matrices,
        nextCardId: state.nextCardId,
        nextMatrixId: state.nextMatrixId,
      };
    },

    loadSnapshot(snapshot) {
      const matrices = new Map<number, MatrixData>();
      for (const entry of snapshot.matrices) {
        const matrix = new MatrixData();
        for (const col of entry.columns) {
          matrix.appendColumn(col.posName, col.data.slice());
          matrix.setColumnAnnotation(matrix.columnCount() - 1, col.annotation);
        }
        matrices.set(entry.id, matrix);
      }

      // The identity cache is deliberately left empty after a restore: the bytes are no
      // longer on disk, so re-dropping the same file must produce a fresh parse rather
      // than silently aliasing to restored data.

      // Rebuild the graph from the restored chart lines. A line references a parsed
      // matrix, so resolve it back to the matrix card that owns it. Refused edges
      // (loops) are skipped — a hand-edited save file must not corrupt close-protection.
      const dependencies = new DependencyGraph();
      let droppedEdges = 0;
      for (const card of snapshot.cards) {
        if (!isChartCard(card)) continue;
        const ownerIds = new Set<number>();
        for (const source of card.config.sources) {
          const owner = snapshot.cards.find(
            (other) =>
              isMatrixCard(other) && other.sources.some((s) => s.matrixId === source.matrixId),
          );
          if (owner) ownerIds.add(owner.id);
        }
        for (const ownerId of ownerIds) {
          if (dependencies.addDependency(card.id, ownerId)) droppedEdges += 1;
        }
      }

      set({
        cards: normalizeRestoredCards(snapshot.cards),
        matrices,
        matrixIdByIdentity: new Map(),
        dependencies,
        // Never trust the counters in the file: a hand-edited (or truncated) snapshot
        // could otherwise hand a new card an id that collides with an existing one.
        nextCardId: Math.max(
          snapshot.nextCardId ?? 0,
          snapshot.cards.reduce((max, card) => Math.max(max, card.id), 0) + 1,
        ),
        nextMatrixId: Math.max(
          snapshot.nextMatrixId ?? 0,
          [...matrices.keys()].reduce((max, id) => Math.max(max, id), 0) + 1,
        ),
        selectedId: null,
        blockedCardId: null,
        blockNonce: 1,
      });

      if (droppedEdges > 0) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycleDropped', { n: droppedEdges }),
        );
      }
    },

    reset() {
      // Matrix ids restart at 1, so cached server ids from the previous workspace would
      // point at the wrong rows after a reset. Drop them together with the matrices.
      backendMatrixIds.clear();
      backendResultLocalIds.clear();
      lastEventSeq = 0;
      stopEventLoop();
      set({
        cards: [],
        matrices: new Map(),
        matrixIdByIdentity: new Map(),
        selectedId: null,
        dependencies: new DependencyGraph(),
        blockedCardId: null,
        blockNonce: 0,
        toast: null,
        // The plane is empty again, so bring the view back to the origin — otherwise the
        // next workspace would open panned into the void left by the previous one.
        view: { x: 0, y: 0, zoom: 1 },
        nextCardId: 1,
        nextMatrixId: 1,
      });
    },
  };
});

// ── Selectors ─────────────────────────────────────────────────────────────

export function useTranslator() {
  const locale = useWorkspace((s) => s.locale);
  // `translatorFor` caches by locale, so `t` keeps one identity for the whole locale.
  // Components put `t` in `useMemo`/`useCallback` dependency arrays; a fresh closure per
  // render used to invalidate every memo that mentioned it.
  const t = translatorFor(locale);
  return { t, locale };
}

export function useCard(id: number): CardModel | undefined {
  return useWorkspace((s) => s.cards.find((c) => c.id === id));
}

export function useMatrix(matrixId: number): MatrixData | undefined {
  return useWorkspace((s) => s.matrices.get(matrixId));
}
