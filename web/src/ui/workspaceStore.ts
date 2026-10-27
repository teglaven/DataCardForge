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
  type FunctionCardModel,
  type MatrixCardModel,
  type MatrixSnapshot,
  type FileIdentity,
  type NodeStatus,
  type PortConnection,
  type WorkspaceSnapshot,
} from './types.ts';
import {
  CHART_PORT_X,
  EXPRESSION_COLUMNS_SIGNATURE,
  INPUT_PORT_SOURCE,
  chartPortId,
} from './migrate.ts';
import { portBindingsFor } from './bindings.ts';
import { translatorFor, detectLocale, type Locale } from './i18n.ts';
import { BackendClient, REQUIRED_CAPABILITIES, type NodeEvent, type SignatureDto } from '../backend/client.ts';

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

/**
 * A pending re-point offer.
 *
 * v2 froze a function card's input to one explicit matrix, which means switching a table's
 * active file does NOT silently re-point it. That is the correct model, but it needs a
 * cheap path back: the store offers the switch as a **one-click, explicit** graph edit and
 * the card shows it as a pending banner. Nothing changes until the user confirms — the
 * difference from v1 is that the edit is announced instead of happening behind their back.
 */
export interface RepointOffer {
  /** The function card that could be re-pointed. */
  cardId: number;
  /** The data card whose active file changed. */
  ownerCardId: number;
  fromMatrixId: number;
  toMatrixId: number;
  /** Column headers identical (same labels, same order) ⇒ a plain one-click confirm. */
  sameColumns: boolean;
  /** Column labels present in the new file but not in the old one. */
  addedLabels: string[];
  /** Column labels present in the old file but gone from the new one. */
  removedLabels: string[];
  /** New row count minus old; row counts never block a re-point (only columns are a map). */
  rowDelta: number;
  fromRows: number;
  toRows: number;
  /** Column count of the new matrix (shown when the headers match). */
  toCols: number;
  /** File name of the new matrix, for the banner text. */
  toName: string;
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
  /** Persist the column-dock open state on a chart card. */
  setChartColumnPanel: (cardId: number, open: boolean) => void;

  // ── function card behaviour ─────────────────────────────────────────
  /**
   * Create a function card reading ONE explicit matrix of `sourceCardId`.
   * Without `matrixId` the card's currently active file is captured — the reference is
   * frozen from this moment on (switching the table's file no longer re-points it).
   */
  addFormulaCard: (sourceCardId: number, matrixId?: number) => number | null;
  /** Add or update a formula column. One node ⇒ one PATCH, whatever the column count. */
  setFormula: (cardId: number, index: number, name: string, expression: string) => void;
  /** Remove a formula column (keeps at least one; no node is created or deleted). */
  removeFormula: (cardId: number, index: number) => void;
  /** Re-send a function card's parameters + bindings to the backend. */
  recomputeFormula: (cardId: number) => void;
  /**
   * Push a card's current matrices into every chart that reads them.
   *
   * Called when a data card switches files (charts re-point at the new file) and when a
   * function card's output arrives (charts re-read the new numbers).
   */
  refreshDependentsOf: (cardId: number) => void;
  /**
   * Pending offers to re-point a function card at the newly active file of its data card.
   * Rebuilt whenever a table switches files; empty once the user applies or dismisses.
   */
  repointOffers: RepointOffer[];
  /** Apply one offer: an explicit, undoable graph edit (re-pointing back is another edit). */
  applyRepoint: (cardId: number) => void;
  /** Apply every offer that reads the same data card (batch confirm). */
  applyRepointsForOwner: (ownerCardId: number) => void;
  /** Keep the current input; the offer disappears until the next file switch. */
  dismissRepoint: (cardId: number) => void;
  /**
   * Name one output column. The first rename also creates the column contract: from then
   * on the output's width is promised, and a drift stops the flow (structured error).
   */
  renameOutputColumn: (cardId: number, index: number, name: string) => void;
  /** Extend/shrink the contract (the explicit way out of a self-edit violation). */
  setColumnContract: (cardId: number, columns: number | null) => void;

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
  /** Function signatures the connected backend advertises (empty until a handshake). */
  signatures: SignatureDto[];
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



/**
 * Make restored cards safe for the B-plan model.
 *
 * A restored function card has no live node (the backend was restarted, or the file
 * predates node registration), so it comes back with `node: null` and its output id
 * reset — `loadSnapshot` then re-registers every card once, which is what restores the
 * four-state light and the numbers. Chart cards saved before the column dock existed lack
 * `columnPanelOpen`; it is normalised to `false`. Matrix cards pass through untouched.
 */
function normalizeRestoredCards(cards: CardModel[]): CardModel[] {
  return cards.map((card) => {
    if (isFormulaCard(card)) {
      return {
        ...card,
        node: null,
        outputs: card.outputs.map((output) => ({ ...output, resultMatrixId: -1 })),
        // Preserve every other parameter: the column contract is a promise the user made,
        // and silently dropping it on restore would un-lock the widths behind their back.
        params: { ...card.params, formulas: card.params.formulas ?? [] },
      };
    }
    if (isChartCard(card)) {
      return { ...card, columnPanelOpen: card.columnPanelOpen ?? false };
    }
    return card;
  });
}

/**
 * Register / patch the ONE backend node behind a function card.
 *
 * v2 (docs/decisions/2026-10-26-card-schema-v2.md): a card is one node with K outputs, so
 * editing an expression PATCHes one node and recomputes once — the v1 mapping needed N
 * nodes and evaluated the same input N times. The node binds the whole source table under
 * port `src` (matrix mode); `params` carries the expressions.
 *
 * Fire-and-forget like registration: never blocks the UI; a genuinely unreachable backend
 * flips the banner (contract 1 — 降级必须可见), it does not fall back to local compute.
 */
async function syncFunctionCard(cardId: number): Promise<void> {
  const state = useWorkspace.getState();
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || !isFormulaCard(card)) return;

  // The node must read the *server-side* copies of the referenced matrices. If one is not
  // registered yet (offline at load time), there is nothing authoritative to bind to —
  // leave the node unregistered and let the offline banner carry the failure.
  const bindings = portBindingsFor(card, (localId) => backendMatrixIds.get(localId) ?? null);
  if (!bindings) return;
  const params: Record<string, unknown> = { formulas: card.params.formulas };

  const existing = card.node;
  const result = existing && existing.nodeId > 0
    ? await backendClient.patchNode(existing.nodeId, { params, inputs: bindings })
    : await backendClient.createNode(bindings, { signatureId: card.signatureId, params });

  if (!result.ok) {
    if (result.code === 'backendUnavailable') {
      useWorkspace.setState({ backend: { state: 'offline', error: result.code } });
    } else {
      // A structured refusal (e.g. cycle) is surfaced on the node so the light goes red
      // and the i18n message renders — visible, never silent.
      markNodeError(cardId, result.code ?? 'internalError', {});
    }
    return;
  }

  const nodeId = result.nodeId!;
  const resultMatrixIds = result.resultMatrixIds ?? (result.resultMatrixId !== undefined ? [result.resultMatrixId] : []);
  applyNodeSnapshot(cardId, {
    nodeId,
    state: result.state ?? 'dirty',
  });
  applyOutputIds(cardId, resultMatrixIds);
  if (result.state === 'done') void pullResultIntoCache(cardId);
}

/** Record a node's state on its card (drives the four-state light). */
function applyNodeSnapshot(cardId: number, status: NodeStatus): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) =>
      card.id === cardId && isFormulaCard(card) ? { ...card, node: status } : card,
    ),
  }));
}

/** Record the server result matrices behind a node's declared outputs. */
function applyOutputIds(cardId: number, resultMatrixIds: number[]): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) => {
      if (card.id !== cardId || !isFormulaCard(card)) return card;
      const outputs = card.outputs.map((output, index) => ({
        ...output,
        resultMatrixId: resultMatrixIds[index] ?? output.resultMatrixId,
      }));
      return { ...card, outputs };
    }),
  }));
}

/** Mark a card's node as errored with a structured code (no result pull attempted). */
function markNodeError(cardId: number, code: string, params: Record<string, unknown>): void {
  useWorkspace.setState((state) => ({
    cards: state.cards.map((card) => {
      if (card.id !== cardId || !isFormulaCard(card)) return card;
      const prev = card.node;
      return {
        ...card,
        node: {
          nodeId: prev?.nodeId ?? -1,
          state: 'error',
          code,
          params,
        },
      };
    }),
  }));
}

/** Find the card a node id belongs to (one node per card in v2). */
function locateCardByNode(nodeId: number): number | null {
  for (const card of useWorkspace.getState().cards) {
    if (isFormulaCard(card) && card.node && card.node.nodeId === nodeId) return card.id;
  }
  return null;
}

/** The server clamps one window request to this many rows (`maxWindowRows`). */
const WINDOW_ROWS = 5000;
/**
 * Upper bound on how many result rows are cached in the browser.
 *
 * A result table is a *display cache*; the authoritative copy stays server-side. 200 000
 * rows covers the 10⁵-row measurements this tool targets with room to spare (≈1.6 MB per
 * column) while keeping a pathological result from exhausting the tab. Above it the read
 * stops and says so — truncation is never silent.
 */
const MAX_CACHE_ROWS = 200_000;

/**
 * Page through a result matrix' windows and assemble the whole table.
 *
 * v1 pulled ONE window (`count=5000`), so a 10 000-row formula silently showed the first
 * half — the numbers were right, the picture lied. Paging is server-side cheap (the frames
 * are binary) and the stop at `MAX_CACHE_ROWS` is reported to the user.
 */
async function fetchFullResult(
  resultMatrixId: number,
): Promise<{ matrix: MatrixData; truncated: boolean } | null> {
  const columns: number[][] = [];
  let names: string[] = [];
  let fetched = 0;
  let truncated = false;

  for (;;) {
    const limit = Math.min(WINDOW_ROWS, MAX_CACHE_ROWS - fetched);
    if (limit <= 0) {
      truncated = true;
      break;
    }
    const frame = await backendClient.window(resultMatrixId, fetched, limit);
    if (!frame.ok) {
      if (frame.code === 'backendUnavailable') {
        useWorkspace.setState({ backend: { state: 'offline', error: frame.code } });
      }
      return null;
    }
    const rows = frame.rows ?? 0;
    if (fetched === 0) names = frame.names ?? [];
    const data = frame.data ?? [];
    for (let c = 0; c < data.length; ++c) {
      const chunk = Array.from(data[c]);
      if (columns[c]) columns[c].push(...chunk);
      else columns[c] = chunk;
    }
    fetched += rows;
    if (rows < limit) break;
  }

  const matrix = new MatrixData();
  for (let c = 0; c < columns.length; ++c) {
    const label = names[c] ?? `Pos.${c + 1}`;
    const space = label.startsWith('Pos.') ? label.indexOf(' ') : -1;
    const posName = space > 0 ? label.slice(0, space) : label;
    const annotation = space > 0 ? label.slice(space + 1) : '';
    matrix.appendColumn(posName, columns[c]);
    matrix.setColumnAnnotation(matrix.columnCount() - 1, annotation);
  }
  return { matrix, truncated };
}

/**
 * Pull a done node's result into the card's display cache.
 *
 * The backend returns the whole wide table (one column per expression) with the expression
 * names attached as annotations, so the browser-side per-column merge and its cache slots
 * are gone. I/O is paged (see `fetchFullResult`); this function only decides where it goes.
 */
async function pullResultIntoCache(cardId: number): Promise<void> {
  const card = useWorkspace.getState().cards.find((c) => c.id === cardId);
  if (!card || !isFormulaCard(card)) return;
  const output = card.outputs[0];
  if (!output || output.resultMatrixId < 0) return;

  const result = await fetchFullResult(output.resultMatrixId);
  if (!result) return;
  useWorkspace.setState((state) => {
    const current = state.cards.find((c) => c.id === cardId);
    if (!current || !isFormulaCard(current)) return {};
    const matrices = new Map(state.matrices);
    matrices.set(current.displayMatrixId, result.matrix);
    return { matrices };
  });
  // A chart drawn from this output must show the numbers that just arrived — the same
  // "dependents follow their source" rule a data card's file switch follows.
  useWorkspace.getState().refreshDependentsOf(cardId);
  if (result.truncated) {
    useWorkspace
      .getState()
      .showToast(
        'error',
        translatorFor(useWorkspace.getState().locale)('status.resultTruncated', {
          n: MAX_CACHE_ROWS,
        }),
      );
  }
}

/**
 * The card that owns a local matrix id.
 *
 * Two kinds can own one: a data card (one per loaded file) and a function card (its
 * output's display cache). Charts, close protection and the edge derivation all need the
 * same answer, so the rule lives in one place — which is also what lets a chart be drawn
 * from a function card's output exactly like from a table (the audit's "公式列无法绘图" gap).
 */
function ownerCardOfMatrix(cards: CardModel[], matrixId: number): CardModel | null {
  for (const card of cards) {
    if (isMatrixCard(card)) {
      if (card.sources.some((source) => source.matrixId === matrixId)) return card;
    } else if (isFormulaCard(card)) {
      if (card.displayMatrixId === matrixId) return card;
    }
  }
  return null;
}

/**
 * Rebuild a chart card's `inputs[]` from its display config.
 *
 * Charts are the one kind whose dependency *edges* are per-column, and the column dock can
 * change them at any moment. Deriving the port list from `config.sources` keeps the two
 * representations in step with a single rule; the graph and the close-protection logic only
 * ever read `inputs`, so a config edit can never leave an edge behind.
 */
function chartInputsFromConfig(card: ChartCardModel, cards: CardModel[]): PortConnection[] {
  const inputs: PortConnection[] = [];
  const ownerIdOf = (matrixId: number): number | undefined =>
    ownerCardOfMatrix(cards, matrixId)?.id;
  for (const source of card.config.sources) {
    const cardId = ownerIdOf(source.matrixId);
    if (cardId === undefined) continue;
    inputs.push({
      portId: chartPortId(source.matrixId, source.columnIndex),
      target: {
        type: 'cell',
        cardId,
        matrixId: source.matrixId,
        column: source.columnIndex,
      },
    });
  }
  const x = card.config.xAxisSource;
  if (x) {
    const cardId = ownerIdOf(x.matrixId);
    if (cardId !== undefined) {
      inputs.push({
        portId: CHART_PORT_X,
        target: { type: 'cell', cardId, matrixId: x.matrixId, column: x.columnIndex },
      });
    }
  }
  return inputs;
}

/**
 * Replace the store's dependency graph with one derived purely from `inputs[]`.
 *
 * This is the whole point of the v2 schema: rebuilding dependencies is one pass with zero
 * per-kind knowledge, so a card kind that forgets to register its edges is impossible
 * rather than merely unlikely (the v1 code rebuilt from chart cards only, which is how
 * formula dependencies used to vanish on reload).
 */
function rebuildDependencies(cards: CardModel[]): {
  dependencies: DependencyGraph;
  droppedEdges: number;
} {
  const dependencies = new DependencyGraph();
  const known = new Set(cards.map((card) => card.id));
  let droppedEdges = 0;
  for (const card of cards) {
    for (const input of card.inputs) {
      const target = input.target.cardId;
      // Skip dangling references and self-loops: a hand-edited file must not corrupt the
      // close-protection invariant.
      if (target === card.id || !known.has(target)) {
        droppedEdges += 1;
        continue;
      }
      if (dependencies.addDependency(card.id, target)) droppedEdges += 1;
    }
  }
  return { dependencies, droppedEdges };
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
  const refreshDependentsOf = (ownerCardId: number): void => {
    const state = get();
    const owner = state.cards.find((c) => c.id === ownerCardId);
    if (!owner) return;

    // A data card re-points dependents at its newly active file; a function card has one
    // output table, so dependents simply re-read it.
    let activeMatrixId: number | undefined;
    let matrixIds: Set<number>;
    if (isMatrixCard(owner)) {
      activeMatrixId = owner.sources[owner.activeSource]?.matrixId;
      matrixIds = new Set(owner.sources.map((source) => source.matrixId));
    } else if (isFormulaCard(owner)) {
      activeMatrixId = owner.displayMatrixId;
      matrixIds = new Set([owner.displayMatrixId]);
    } else {
      return;
    }
    if (activeMatrixId === undefined) return;
    const activeMatrix = state.matrices.get(activeMatrixId);
    if (!activeMatrix) return;

    const dependentIds = new Set(state.dependencies.getDependents(ownerCardId));
    if (dependentIds.size === 0) return;

    /**
     * Re-point one attached column at the newly active matrix.
     *
     * A column that vanished in the new file keeps its previous values so the curve does
     * not silently disappear — the behaviour the Qt frontend settled on.
     */
    const rePoint = (source: ChartSource): ChartSource => {
      if (source.columnIndex >= activeMatrix.columnCount()) {
        return { ...source, matrixId: activeMatrixId };
      }
      const column = activeMatrix.column(source.columnIndex);
      return {
        ...source,
        matrixId: activeMatrixId,
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

          if (!changed) return card;
          const next: ChartCardModel = {
            ...card,
            config: { ...card.config, sources, xAxisSource },
          };
          // Charts follow the new file by design (a chart is a *view*), so their
          // authoritative edges are re-derived from the re-pointed config in the same
          // pass — an edge can never describe a matrix the chart no longer shows.
          next.inputs = chartInputsFromConfig(next, state.cards);
          return next;
        }

        // A function card does NOT follow: v2 freezes its input to one explicit matrix, so
        // switching a table's active file leaves its numbers alone until the user
        // explicitly re-points it (docs/decisions/2026-10-26-card-schema-v2.md §迁移).
        return card;
      });

      return { cards };
    });
  };

  /**
   * The matrix a chart should read from `card`: a data card's active file, or a function
   * card's output table. `null` when the owner has nothing to show yet.
   */
  const chartSourceMatrixId = (card: CardModel): number | null => {
    if (isMatrixCard(card)) {
      return card.sources[card.activeSource]?.matrixId ?? null;
    }
    if (isFormulaCard(card)) {
      const matrix = get().matrices.get(card.displayMatrixId);
      return matrix ? card.displayMatrixId : null;
    }
    return null;
  };

  /**
   * Build the re-point offers a file switch creates for function cards reading that table.
   *
   * Only cards whose input targets one of the switching card's matrices are offered, and a
   * card whose input already points at the newly active matrix is not (nothing to apply).
   * The column diff is what decides whether the offer is a plain confirm or needs the
   * "apply anyway" path: expressions reference columns BY NAME, so a changed header set is
   * the one difference that can silently change what the card computes.
   */
  const buildRepointOffers = (
    cards: CardModel[],
    ownerCardId: number,
    newActiveMatrixId: number,
  ): RepointOffer[] => {
    const owner = cards.find((card) => card.id === ownerCardId);
    if (!owner || !isMatrixCard(owner)) return [];
    const ownedMatrixIds = new Set(owner.sources.map((source) => source.matrixId));
    const newMatrix = get().matrices.get(newActiveMatrixId);
    const labelSet = (matrixId: number): { labels: string[]; rows: number } | null => {
      const matrix = get().matrices.get(matrixId);
      if (!matrix) return null;
      return {
        labels: matrix.columns().map((column) => column.annotation || column.posName),
        rows: matrix.rowCount(),
      };
    };
    const next = labelSet(newActiveMatrixId);
    if (!next) return [];

    const offers: RepointOffer[] = [];
    for (const card of cards) {
      if (!isFormulaCard(card)) continue;
      const input = card.inputs.find((entry) => entry.portId === INPUT_PORT_SOURCE);
      if (!input || input.target.type !== 'matrix') continue;
      if (!ownedMatrixIds.has(input.target.matrixId)) continue;
      if (input.target.matrixId === newActiveMatrixId) continue;
      const previous = labelSet(input.target.matrixId);
      if (!previous) continue;

      const previousSet = new Set(previous.labels);
      const nextSet = new Set(next.labels);
      const sameColumns =
        previous.labels.length === next.labels.length &&
        previous.labels.every((label, index) => label === next.labels[index]);
      offers.push({
        cardId: card.id,
        ownerCardId,
        fromMatrixId: input.target.matrixId,
        toMatrixId: newActiveMatrixId,
        sameColumns,
        addedLabels: next.labels.filter((label) => !previousSet.has(label)),
        removedLabels: previous.labels.filter((label) => !nextSet.has(label)),
        fromRows: previous.rows,
        toRows: next.rows,
        toCols: next.labels.length,
        rowDelta: next.rows - previous.rows,
        toName:
          owner.sources.find((source) => source.matrixId === newActiveMatrixId)?.name ??
          `#${newActiveMatrixId}`,
      });
    }
    void newMatrix;
    return offers;
  };

  /**
   * Commit a chart config change and keep `inputs[]` (the authoritative edges) in step.
   *
   * Every chart mutation funnels through here, so there is exactly one rule for "which
   * cards does this chart read?" and it is applied atomically: new owner edges are
   * validated for cycles BEFORE anything is written (a refused edit leaves the chart and
   * the graph untouched), stale edges are dropped afterwards.
   */
  const commitChartConfig = (
    cardId: number,
    mutate: (config: ChartConfig) => ChartConfig,
  ): boolean => {
    const state = get();
    const card = state.cards.find((c) => c.id === cardId);
    if (!card || !isChartCard(card)) return false;
    const nextConfig = mutate(card.config);
    if (nextConfig === card.config) return true;

    const cards = state.cards.map((entry) =>
      entry.id === cardId && isChartCard(entry) ? { ...entry, config: nextConfig } : entry,
    );
    const nextCard = cards.find((c) => c.id === cardId) as ChartCardModel;
    const nextInputs = chartInputsFromConfig(nextCard, cards);

    const beforeOwners = new Set(card.inputs.map((input) => input.target.cardId));
    const afterOwners = new Set(nextInputs.map((input) => input.target.cardId));
    for (const ownerId of afterOwners) {
      if (beforeOwners.has(ownerId)) continue;
      const cycle = state.dependencies.addDependency(cardId, ownerId);
      if (cycle) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return false;
      }
    }
    for (const ownerId of beforeOwners) {
      if (!afterOwners.has(ownerId)) state.dependencies.removeDependency(cardId, ownerId);
    }
    set({ cards: cards.map((entry) => (entry.id === cardId ? { ...nextCard, inputs: nextInputs } : entry)) });
    return true;
  };

  return {
    cards: [],
    matrices: new Map(),
    matrixIdByIdentity: new Map(),
    selectedId: null,
    dependencies: new DependencyGraph(),
    blockedCardId: null,
    blockNonce: 0,
    repointOffers: [],
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
        // A table is a data source: `sources[]` is content, never a dependency.
        inputs: [],
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

    addChartCard(ownerCardId, columnIndex, chartType) {
      const state = get();
      const ownerCard = state.cards.find((c) => c.id === ownerCardId);
      if (!ownerCard || isChartCard(ownerCard)) return null;

      // A table's active file, or a function card's output table — both are matrices the
      // chart can read, which is what makes a dataflow edge out of a function card.
      const sourceMatrixId = chartSourceMatrixId(ownerCard);
      if (sourceMatrixId === null) return null;
      const matrix = state.matrices.get(sourceMatrixId);
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
          matrixId: sourceMatrixId,
          columnIndex: index,
          label: columnLabel(column),
          raw: column.data.slice(),
        });
      }
      if (sources.length < minimumColumns(type)) return null;

      const cardId = state.nextCardId;
      const chartSize = { width: 560, height: 400 };
      // Beside the card it was opened from, so the connection line stays short.
      const chartSpot = placeOnPlane(
        { x: ownerCard.x + ownerCard.width + 32, y: ownerCard.y + 24 },
        chartSize,
        state.cards,
      );
      const config = defaultChartConfig(type, sources);
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
        inputs: [],
        config,
        smoothing: { ...DEFAULT_SMOOTHING },
        // The column dock starts closed; the user's toggle is persisted via
        // setChartColumnPanel.
        columnPanelOpen: false,
      };
      // Edges are derived from the display config (one rule for every config edit).
      card.inputs = chartInputsFromConfig(card, state.cards);
      const cardIds = card.inputs.map((input) => input.target.cardId);
      if (cardIds.length === 0) return null;

      // The chart depends on the matrix *card*: this is what makes "switch file in the
      // table, chart follows" work even though each file is a separate matrix.
      // Guarded against loops — once FunctionCard chains cards together, a chart could
      // otherwise end up depending on itself through a longer path.
      for (const ownerId of new Set(cardIds)) {
        const cycle = state.dependencies.addDependency(cardId, ownerId);
        if (cycle) {
          get().showToast(
            'error',
            translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
          );
          return null;
        }
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

      // A card that still feeds another card must not disappear under it. That used to be
      // a matrix-card-only rule; a function card's output can feed charts too, so the rule
      // is now stated once, for every card that can be a source.
      if (!isChartCard(card) && state.dependencies.hasDependents(id)) {
        set({
          blockedCardId: id,
          blockNonce: state.blockNonce + 1,
          selectedId: id,
        });
        return false;
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
        // A function card owns its display cache outright; no other card references it, so
        // it must not be left behind in the map.
        matrices.delete(card.displayMatrixId);
        // Delete the one backing node server-side. `DELETE /api/nodes/{id}` also drops its
        // result matrices, which is what releases the compute graph on close.
        const nodeId = card.node?.nodeId ?? -1;
        if (nodeId > 0) {
          void backendClient.deleteNode(nodeId).then((result) => {
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
      refreshDependentsOf(cardId);

      // Function cards do NOT follow automatically (v2). Offer the switch instead: the
      // card shows a pending banner and nothing changes until the user confirms.
      const active = get().cards.find((c) => c.id === cardId);
      const activeMatrixId =
        active && isMatrixCard(active)
          ? active.sources[active.activeSource]?.matrixId
          : undefined;
      if (activeMatrixId !== undefined) {
        set({ repointOffers: buildRepointOffers(get().cards, cardId, activeMatrixId) });
      }
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
      refreshDependentsOf(cardId);

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

      commitChartConfig(cardId, (config) => ({ ...config, type, sources }));
    },

    setChartConfig(cardId, patch) {
      commitChartConfig(cardId, (config) => ({ ...config, ...patch }));
    },

    addChartSource(cardId, matrixId, columnIndex) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isChartCard(card)) return;
      // Never attach the same column twice.
      if (
        card.config.sources.some(
          (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
        )
      ) {
        return;
      }
      const matrix = state.matrices.get(matrixId);
      if (!matrix || columnIndex < 0 || columnIndex >= matrix.columnCount()) return;

      // The owner edge (chart → data or function card) is derived by commitChartConfig
      // from the new source list, so a cycle is refused there and nothing is attached.
      const column = matrix.column(columnIndex);
      const source: ChartSource = {
        matrixId,
        columnIndex,
        label: columnLabel(column),
        raw: column.data.slice(),
      };
      commitChartConfig(cardId, (config) => ({
        ...config,
        sources: [...config.sources, source],
      }));
    },

    removeChartSource(cardId, matrixId, columnIndex) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isChartCard(card)) return;

      const sources = card.config.sources.filter(
        (source) => !(source.matrixId === matrixId && source.columnIndex === columnIndex),
      );
      // A chart with no columns has nothing to draw; keep at least one. Also refuse to
      // drop below what the *current type* needs: silently degrading a scatter to
      // "needs at least 2 columns" destroys work the user cannot undo.
      const floor = Math.max(1, minimumColumns(card.config.type));
      if (sources.length < floor) return;
      // The X axis may have pointed at the column just removed.
      const xAxisSource =
        card.config.xAxisSource &&
        card.config.xAxisSource.matrixId === matrixId &&
        card.config.xAxisSource.columnIndex === columnIndex
          ? null
          : card.config.xAxisSource;

      // The card-level edge disappears on its own when the recomputed inputs no longer
      // mention that owner — commitChartConfig diffs the owner set.
      commitChartConfig(cardId, (config) => ({ ...config, sources, xAxisSource }));
    },

    setChartColumnPanel(cardId, open) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isChartCard(card) ? { ...card, columnPanelOpen: open } : card,
        ),
      }));
    },

    // ── function card behaviour ───────────────────────────────────────

    addFormulaCard(sourceCardId, matrixId) {
      const state = get();
      const sourceCard = state.cards.find((c) => c.id === sourceCardId);
      if (!sourceCard || !isMatrixCard(sourceCard)) return null;
      // v2: the reference is ONE explicit matrix. Without an explicit id the card captures
      // the file showing right now — and keeps reading it whatever the table does later.
      const targetMatrixId = matrixId ?? sourceCard.sources[sourceCard.activeSource]?.matrixId;
      if (targetMatrixId === undefined) return null;
      if (!sourceCard.sources.some((entry) => entry.matrixId === targetMatrixId)) return null;
      const sourceMatrix = state.matrices.get(targetMatrixId);
      if (!sourceMatrix) return null;

      const cardId = state.nextCardId;
      const displayMatrixId = state.nextMatrixId;

      // Start with one expression referencing the first column. The identifier must be
      // the label the backend resolves against — annotation when present, else Pos.N — not
      // the raw posName: `Pos.1 * 2` fails on a table whose first column is annotated `A`.
      const firstColLabel =
        sourceMatrix.columnCount() > 0 ? sourceColumnLabel(sourceMatrix.column(0)) : 'A';
      const formulas = [{ name: `${firstColLabel} × 2`, expression: `${firstColLabel} * 2` }];

      // The display cache starts EMPTY. It is filled only once the backend reports the node
      // `done` and we pull its result window — the browser computes nothing
      // (docs/decisions/2026-10-17-backend-owns-compute.md).
      const matrices = new Map(state.matrices);
      matrices.set(displayMatrixId, new MatrixData());

      const formulaSize = { width: 520, height: 380 };
      const formulaSpot = placeOnPlane(
        { x: sourceCard.x + 40, y: sourceCard.y + sourceCard.height + 32 },
        formulaSize,
        state.cards,
      );
      const inputs: PortConnection[] = [
        {
          portId: INPUT_PORT_SOURCE,
          target: { type: 'matrix', cardId: sourceCardId, matrixId: targetMatrixId },
        },
      ];
      const card: FunctionCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        ...formulaSpot,
        width: formulaSize.width,
        height: formulaSize.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        inputs,
        signatureId: EXPRESSION_COLUMNS_SIGNATURE,
        params: { formulas },
        outputs: [{ outputId: 'result', resultMatrixId: -1 }],
        node: null,
        displayMatrixId,
      };

      const cycle = state.dependencies.addDependency(cardId, sourceCardId);
      if (cycle) {
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return null;
      }

      set({
        cards: [...state.cards, card],
        matrices,
        nextCardId: cardId + 1,
        nextMatrixId: displayMatrixId + 1,
        selectedId: cardId,
      });
      revealCard({ ...formulaSpot, ...formulaSize });

      void syncFunctionCard(cardId);
      return cardId;
    },

    setFormula(cardId, index, name, expression) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;

      const formulas = card.params.formulas.slice();
      if (index >= 0 && index < formulas.length) {
        formulas[index] = { name, expression };
      } else {
        formulas.push({ name, expression });
      }

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c)
            ? { ...c, params: { ...c.params, formulas } }
            : c,
        ),
      });

      // One card = one node, so an edit is ONE PATCH (v1 needed one per column, and each
      // of those re-evaluated the same input). Results arrive on the event stream.
      void syncFunctionCard(cardId);
    },

    removeFormula(cardId, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      if (card.params.formulas.length <= 1) return; // keep at least one

      const formulas = card.params.formulas.filter((_, i) => i !== index);

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c)
            ? { ...c, params: { ...c.params, formulas } }
            : c,
        ),
      });

      // No node to release: the node stays, it simply computes fewer columns next time.
      void syncFunctionCard(cardId);
    },

    refreshDependentsOf(cardId) {
      refreshDependentsOf(cardId);
    },

    recomputeFormula(cardId) {
      // "Recompute" means "re-send the parameters + binding to the backend"; the browser
      // never evaluates. The binding is the card's explicit matrix — it does not drift with
      // the table's active file (that is now an explicit re-point).
      void syncFunctionCard(cardId);
    },

    applyRepoint(cardId) {
      const state = get();
      const offer = state.repointOffers.find((entry) => entry.cardId === cardId);
      if (!offer) return;
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;

      // Re-point the envelope AND the dependency edge in one step: the offer is the only
      // producer of this edit, so the target card id cannot change here (same data card).
      const inputs = card.inputs.map((entry) =>
        entry.portId === INPUT_PORT_SOURCE && entry.target.type === 'matrix'
          ? { ...entry, target: { ...entry.target, matrixId: offer.toMatrixId } }
          : entry,
      );
      set({
        cards: state.cards.map((entry) => (entry.id === cardId ? { ...card, inputs } : entry)),
        repointOffers: state.repointOffers.filter((entry) => entry.cardId !== cardId),
      });
      // One PATCH: the node is told about its new input, exactly like an explicit re-wire.
      void syncFunctionCard(cardId);
    },

    applyRepointsForOwner(ownerCardId) {
      const state = get();
      const targets = state.repointOffers.filter((offer) => offer.ownerCardId === ownerCardId);
      if (targets.length === 0) return;
      const byCard = new Map(targets.map((offer) => [offer.cardId, offer]));
      const cards = state.cards.map((card) => {
        const offer = byCard.get(card.id);
        if (!offer || !isFormulaCard(card)) return card;
        const inputs = card.inputs.map((entry) =>
          entry.portId === INPUT_PORT_SOURCE && entry.target.type === 'matrix'
            ? { ...entry, target: { ...entry.target, matrixId: offer.toMatrixId } }
            : entry,
        );
        return { ...card, inputs };
      });
      set({
        cards,
        repointOffers: state.repointOffers.filter((offer) => offer.ownerCardId !== ownerCardId),
      });
      for (const cardId of byCard.keys()) void syncFunctionCard(cardId);
    },

    dismissRepoint(cardId) {
      set((state) => ({
        repointOffers: state.repointOffers.filter((offer) => offer.cardId !== cardId),
      }));
    },

    renameOutputColumn(cardId, index, name) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      const formulas = card.params.formulas.slice();
      if (index < 0 || index >= formulas.length) return;
      const current = formulas[index];
      if (current.name === name) return;
      formulas[index] = { ...current, name };
      // Naming a column IS the moment the output's width becomes a promise: the mapping is
      // position-based, so a width drift would silently move a user-given label onto a
      // different column. From here on the node refuses to publish a different width.
      const columnContract = card.params.columnContract ?? {
        outputId: card.outputs[0]?.outputId ?? 'result',
        columns: formulas.length,
      };
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry)
            ? { ...entry, params: { ...entry.params, formulas, columnContract } }
            : entry,
        ),
      });
      void syncFunctionCard(cardId);
    },

    setColumnContract(cardId, columns) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      const params: FunctionCardModel['params'] = { ...card.params };
      if (columns === null) {
        delete params.columnContract;
      } else {
        params.columnContract = {
          outputId: card.outputs[0]?.outputId ?? 'result',
          columns,
        };
      }
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isFormulaCard(entry) ? { ...entry, params } : entry,
        ),
      });
      void syncFunctionCard(cardId);
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
    signatures: [],
    connectBackend: async () => {
      const info = await backendClient.hello();
      const missing = info.ok
        ? REQUIRED_CAPABILITIES.filter((cap) => !(info.capabilities ?? []).includes(cap))
        : [];
      if (info.ok && missing.length > 0) {
        // Additive or not, this backend cannot evaluate function cards: say so instead of
        // creating nodes it will silently misinterpret.
        stopEventLoop();
        set({
          backend: { state: 'mismatch', error: `missing-capability:${missing.join(',')}` },
        });
        return;
      }
      if (info.ok) {
        set({ backend: { state: 'online', build: info.build, protocol: info.protocol } });
        // Advertised signatures (built-ins today, plugin registrations later).
        void backendClient.signatures().then((signatures: SignatureDto[]) => {
          if (signatures.length > 0) set({ signatures });
        });
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
      const cardId = locateCardByNode(event.nodeId);
      if (cardId === null) return;
      applyNodeSnapshot(cardId, {
        nodeId: event.nodeId,
        state: event.state,
        ...(event.code !== undefined ? { code: event.code } : {}),
        ...(event.params !== undefined ? { params: event.params } : {}),
      });
      // A finished computation is the trigger to pull the numbers — the display cache is
      // refreshed from the window endpoint, never from a local evaluation.
      if (event.state === 'done') void pullResultIntoCache(cardId);
    },

    startBackendEventLoop() {
      stopEventLoop();
      const controller = new AbortController();
      eventLoopAbort = controller;
      void (async () => {
        while (!controller.signal.aborted) {
          const events = await backendClient.events(lastEventSeq, controller.signal);
          if (controller.signal.aborted) break;
          // A malformed answer must not kill the long-poll loop (the banner is the signal
          // for "the backend is unusable", not an exception in a detached async task)…
          const list = Array.isArray(events) ? events : [];
          for (const event of list) get().applyNodeEvent(event);
          // …and it must not turn the loop into a busy poll: `events()` resolves empty on
          // timeout or transport failure, and "not even an array" is the same situation.
          // Without this the pause was skipped and the loop hammered the backend at full
          // speed (found by a test whose stub answered the wrong shape).
          if (list.length === 0) await sleep(250);
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
        version: 2,
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

      // Rebuild the graph from `inputs[]` — the ONE place dependencies live, so this pass
      // needs no per-kind knowledge (the v1 code rebuilt from chart cards only, which is
      // exactly how restored formula dependencies used to vanish). Refused edges are
      // skipped: a hand-edited save file must not corrupt close-protection.
      const restored = normalizeRestoredCards(snapshot.cards);
      const { dependencies, droppedEdges } = rebuildDependencies(restored);

      set({
        cards: restored,
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

      // Bring the restored state back to the server: the backend's matrix and node ids do
      // not survive a restart, so a restore has to re-register the matrices first and can
      // only then bind function-card nodes to them. Martices are registered in id order so
      // the local→server mapping is deterministic; function cards that cannot register
      // (offline backend) simply stay grey and the banner carries the failure (contract 1).
      void (async () => {
        const ordered = [...matrices.entries()].sort((a, b) => a[0] - b[0]);
        for (const [localId, matrix] of ordered) {
          if (backendMatrixIds.has(localId)) continue;
          const columns = matrix.columns().map((col) => ({
            posName: col.posName,
            annotation: col.annotation,
            data: col.data,
          }));
          const serverId = await get().registerMatrixWithBackend(`#${localId}`, columns);
          if (serverId !== null) backendMatrixIds.set(localId, serverId);
        }
        for (const card of restored) {
          if (isFormulaCard(card)) void syncFunctionCard(card.id);
        }
      })();
    },

    reset() {
      // Matrix ids restart at 1, so cached server ids from the previous workspace would
      // point at the wrong rows after a reset. Drop them together with the matrices.
      backendMatrixIds.clear();
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
