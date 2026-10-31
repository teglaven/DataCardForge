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
  type MatrixEntry,
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
  REGRESSION_SIGNATURE,
  chartPortId,
} from './migrate.ts';
import { portBindingsFor, REGRESSION_PORT_X, REGRESSION_PORT_Y } from './bindings.ts';
import { translatorFor, detectLocale, type Locale } from './i18n.ts';
// Type-only: the store owns *whether* the reference is open, the content module owns what
// is in it. Importing the type alone keeps the catalogue out of the store's runtime.
import type { HelpSection } from './formulaHelp.ts';
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
  /**
   * Replace a data card's file(s) without touching the card itself.
   *
   * `index` replaces ONE source slot — the card's「替换文件…」control, which always acts on
   * the active file. Omitted, the entries become the card's whole file set (a drop).
   *
   * This is a DATA change, not a view change (`setActiveSource` is the view change, and the
   * two must not be conflated). Charts are views and follow the new numbers. Function cards
   * are frozen to explicit matrices (v2), so their input is rewritten to the corresponding
   * new matrix of the same card in the same step: "this table now holds these numbers" is
   * exactly what the user asked for, and the cell-edit cascade (PATCH → recompute) is the
   * precedent — the column contract still stops a shape drift with a visible error.
   *
   * Returns false for a non-data card or invalid arguments; a partial parse must be
   * aborted by the caller, never applied here.
   */
  replaceCardSources: (cardId: number, entries: MatrixEntry[], index?: number) => boolean;
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
  /**
   * Create a relation-enumeration card from two columns of the source's current table.
   *
   * Backed by `builtin:linear-regression` (the published signature id never changes; only
   * the human-facing name did). The second signature exists to prove the card model is not
   * expression-shaped: two declared ports (x, y), no formula parameters, an output whose
   * shape the signature fixes. It binds one COLUMN per port (`mode: 'cell'`), which is why
   * the cell port mode had to become real.
   *
   * The clicked column becomes `x` and its neighbour `y` (the previous one when the clicked
   * column is last) — a starting pair, not a restriction: both ports can be re-bound from
   * the card (`setPortColumn`), which is the "choose the columns" affordance the card was
   * missing when the pair was hard-wired at creation.
   */
  addRelationEnumCard: (sourceCardId: number, columnIndex: number) => number | null;
  /**
   * Re-bind ONE cell port of a function card to another column of the same matrix.
   *
   * Column choice is a BINDING, not a parameter: the parameter belongs to the signature
   * (`params` is empty for this signature), while "which column feeds port x" is data flow.
   * Same node, same dependency edge — only `columnIndex` changes, then one push re-computes.
   */
  setPortColumn: (cardId: number, portId: string, columnIndex: number) => void;
  /** Add or update a formula column. One node ⇒ one PATCH, whatever the column count. */
  setFormula: (cardId: number, index: number, name: string, expression: string) => void;
  /** Remove a formula column (keeps at least one; no node is created or deleted). */
  removeFormula: (cardId: number, index: number) => void;
  /** Re-send a function card's parameters + bindings to the backend. */
  recomputeFormula: (cardId: number) => void;
  /**
   * Pull the WHOLE result of a function card into the display cache ("show more").
   *
   * The card mirrors only `RESULT_PREVIEW_ROWS` rows after a compute; this is the explicit
   * user action that pays for the rest of a tall table.
   */
  loadFullResult: (cardId: number) => void;
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

  // ── help dialog (帮助) ───────────────────────────────────────────────
  /**
   * The formula / function reference is a modal the app owns, not a card.
   *
   * It is reachable from two unrelated places — the top-left Help menu and the formula
   * card's `?` button — and the card gets no props from `CardCanvas` for it. Two openers,
   * one piece of state: that is what the store is for.
   */
  helpOpen: boolean;
  /** Section the opener asked the dialog to scroll to; `null` means "open at the top". */
  helpSection: HelpSection | null;
  openHelp: (section?: HelpSection) => void;
  closeHelp: () => void;

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
/**
 * Uploads already on their way, by local matrix id.
 *
 * Two paths legitimately race: a file load registers its parse, and a reconnect registers
 * everything still missing. Without this map both would POST the same table and the loser's
 * server copy would leak — the same coalescing `syncingCards` does for function nodes.
 */
const matrixUploads = new Map<number, Promise<number | null>>();

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
 * Characters the expression grammar treats as structure, mirrored from the tokenizer
 * (`backend/src/expression.cpp` / `core/expression.ts`). A name containing one of these is
 * only reachable through `[列名]`.
 */
const STRUCTURAL_IN_NAME = /[\s+\-*/^%<>=!,()[\]（）［］【】，、×÷＋－＊／％＾＝＞＜≠　]/;

/**
 * The spelling a generated default formula should use for a column.
 *
 * The friendly annotation is preferred — it is what the user reads in the table — but only
 * when the tokenizer can actually read it back. `地面速度_μm/s` cannot (`/` is division),
 * and a label that *starts* with a digit or `.` cannot either: the tokenizer opens a number
 * literal there, so `2号测点` reads as `2` followed by a stray identifier. Both fall back to
 * `Pos.N`, which always resolves (`buildColumnMap` registers it for every column).
 */
function formulaReference(column: { posName: string; annotation: string }): string {
  const label = sourceColumnLabel(column);
  // A leading digit/dot is the lexer's rule (number literals win), not just a fully numeric
  // label: "2号测点" is unspellable bare while "2" alone is merely a literal.
  if (label === '' || STRUCTURAL_IN_NAME.test(label) || /^[\d.]/.test(label)) {
    return column.posName;
  }
  return label;
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
 * Server id for a local matrix — with a function card's display cache resolved through its
 * owning card.
 *
 * A formula card's output table exists in the browser only as a display cache
 * (`displayMatrixId`); the authoritative copy is the node's result matrix, whose id is
 * recorded on `outputs[]`. Nothing registers the display matrix itself — `backendMatrixIds`
 * deliberately holds uploaded tables only (see `loadSnapshot`'s derived-matrix exclusion) —
 * so the local→server map can never answer for it. Resolving through the owning card is
 * what lets a chart or a chained function card read a formula card's output; the backend
 * already accepts a result matrix as `sourceMatrixId`.
 */
function backendMatrixIdFor(localMatrixId: number): number | null {
  const mapped = backendMatrixIds.get(localMatrixId);
  if (mapped !== undefined) return mapped;
  for (const card of useWorkspace.getState().cards) {
    if (!isFormulaCard(card) || card.displayMatrixId !== localMatrixId) continue;
    const serverId = card.outputs[0]?.resultMatrixId ?? -1;
    return serverId > 0 ? serverId : null;
  }
  return null;
}

/** Cards with a node push in flight, and cards asked again while that push ran. */
const syncingCards = new Set<number>();
const resyncRequested = new Set<number>();
/**
 * Workspace generation. Bumped by `reset` / `loadSnapshot`: card ids restart at 1 after a
 * reset, so a push that started in the previous workspace must not bind its node to the
 * card that happens to inherit the same id.
 */
let workspaceEpoch = 0;

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
  // One node per card: two overlapping pushes both read `node === null` and create two
  // nodes, and the loser is orphaned server-side (its result matrix is never released).
  // Coalesce rather than drop — the edit that arrived mid-flight must still land, so the
  // card is pushed once more with its latest state when the current push settles.
  if (syncingCards.has(cardId)) {
    resyncRequested.add(cardId);
    return;
  }
  syncingCards.add(cardId);
  try {
    await pushFunctionCard(cardId);
  } finally {
    syncingCards.delete(cardId);
    if (resyncRequested.delete(cardId)) void syncFunctionCard(cardId);
  }
}

/**
 * Wait until no card push is in flight or requested — i.e. the server's node bindings have
 * caught up with the store.
 *
 * Needed before releasing a server-side matrix: the backend refuses `DELETE /api/matrices`
 * while a node still reads it (`hasDependents`, HTTP 409), and a 409 is a failed request
 * the browser logs as a console error. Awaiting `syncFunctionCard` is not enough on its own
 * because a coalesced call returns immediately and schedules one more push. Bounded, so a
 * wedged backend cannot hang a caller; on timeout the caller keeps the server copy instead.
 */
async function waitForCardPushes(timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (syncingCards.size === 0 && resyncRequested.size === 0) return;
    await sleep(40);
  }
}

/**
 * Release a server-side matrix copy, ignoring a refusal.
 *
 * The backend refuses the delete while a node still reads the matrix; by the time this is
 * called the readers have been re-bound, so a refusal can only come from a failed PATCH.
 * The copy then leaks (invisible), instead of retrying behind the user's back.
 */
function releaseServerMatrix(serverId: number): void {
  void backendClient.deleteMatrix(serverId);
}

async function pushFunctionCard(cardId: number): Promise<void> {
  const state = useWorkspace.getState();
  const card = state.cards.find((c) => c.id === cardId);
  if (!card || !isFormulaCard(card)) return;

  // The node must read the *server-side* copies of the referenced matrices. A missing id
  // (offline, or not registered yet) is not an error: the card stays unbound and the
  // registration callback / upstream push retries it (syncUnbound* below), instead of
  // leaving it unusable forever.
  const bindings = portBindingsFor(card, backendMatrixIdFor);
  if (!bindings) return;
  const params: Record<string, unknown> = { formulas: card.params.formulas };

  const existing = card.node;
  // Identity of the card this push was started for: it can be closed (or the whole
  // workspace replaced) while the request is in flight, and a later card may reuse the id.
  const startedInEpoch = workspaceEpoch;
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
  // Closing a card while its create is in flight cannot release a node that did not exist
  // yet, so the fresh node (and its result matrices) would leak server-side forever. The
  // close is the newer intent, so the node is the thing that goes.
  const stillCurrent =
    workspaceEpoch === startedInEpoch &&
    useWorkspace.getState().cards.some((entry) => entry.id === cardId && isFormulaCard(entry));
  if (!stillCurrent) {
    if (!existing) void backendClient.deleteNode(nodeId);
    return;
  }
  // A PATCH response carries no output ids (only nodeId + state), so an empty list must
  // not overwrite the ids recorded at creation — outputs[] keeps the previous values.
  const resultMatrixIds = result.resultMatrixIds ?? (result.resultMatrixId !== undefined ? [result.resultMatrixId] : []);
  applyNodeSnapshot(cardId, {
    nodeId,
    state: result.state ?? 'dirty',
  });
  if (resultMatrixIds.length > 0) applyOutputIds(cardId, resultMatrixIds);
  // A downstream card may have been created before this card had a node or a result id;
  // now that it has one, the binding can be completed.
  syncUnboundDependents(cardId);
  if (result.state === 'done') void pullResultIntoCache(cardId);
}

/**
 * Re-attempt binding for unbound formula cards that read `ownerCardId`'s output.
 *
 * The chain is built from the upstream card's result menu, and that card may still be
 * computing (or have no node yet). Nothing else retries the binding, so without this an
 * unbound downstream card used to stay "No result yet" forever.
 */
function syncUnboundDependents(ownerCardId: number): void {
  for (const card of useWorkspace.getState().cards) {
    if (!isFormulaCard(card) || card.node !== null) continue;
    if (card.inputs.some((input) => input.target.cardId === ownerCardId)) {
      void syncFunctionCard(card.id);
    }
  }
}

/** Same retry for a matrix that finished registering after the card was created. */
function syncUnboundReadersOfMatrix(localMatrixId: number): void {
  for (const card of useWorkspace.getState().cards) {
    if (!isFormulaCard(card) || card.node !== null) continue;
    if (card.inputs.some((input) => input.target.matrixId === localMatrixId)) {
      void syncFunctionCard(card.id);
    }
  }
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
 * Upper bound on how many result rows are ever cached in the browser.
 *
 * A result table is a *display cache*; the authoritative copy stays server-side. 200 000
 * rows covers the 10⁵-row measurements this tool targets with room to spare (≈1.6 MB per
 * column) while keeping a pathological result from exhausting the tab. Above it the read
 * stops and says so — truncation is never silent.
 */
const MAX_CACHE_ROWS = 200_000;
/**
 * Rows a function card shows by default.
 *
 * A 165 000-row result used to be paged down in full before the card could paint: 34
 * window requests at ~40 ms each, three times over, i.e. seconds of waiting for numbers
 * the first screenful already proved correct. The card now mirrors this many rows and the
 * "show more" action fetches the rest — the dense-matrix frame carries the total shape, so
 * the card can say "100 of 165 000" without downloading the table.
 */
const RESULT_PREVIEW_ROWS = 100;

interface ResultFetch {
  matrix: MatrixData;
  /** Rows mirrored into the cache (= matrix.rowCount()). */
  shownRows: number;
  /** Rows of the stored result matrix, from the frame's shape header. */
  totalRows: number;
  /** The cache stopped at `MAX_CACHE_ROWS` instead of the end of the data. */
  truncated: boolean;
}

/**
 * Page through a result matrix' windows and assemble up to `rowBudget` rows.
 *
 * `rowBudget` is what separates "first screenful" (`RESULT_PREVIEW_ROWS`) from "the whole
 * result" (`loadFullResult`). Paging is server-side cheap (binary frames) and the stop at
 * `MAX_CACHE_ROWS` is reported to the user.
 */
async function fetchResultRows(resultMatrixId: number, rowBudget: number): Promise<ResultFetch | null> {
  const budget = Math.min(rowBudget, MAX_CACHE_ROWS);
  const columns: number[][] = [];
  let names: string[] = [];
  let fetched = 0;
  let totalRows = 0;
  let truncated = false;

  for (;;) {
    const limit = Math.min(WINDOW_ROWS, budget - fetched);
    if (limit <= 0) {
      // Budget exhausted. Only call it truncation when the matrix is genuinely taller than
      // what the cache is allowed to hold (a 100-row preview of 100 rows is complete).
      truncated = totalRows > fetched && budget >= MAX_CACHE_ROWS;
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
    const data = frame.data ?? [];
    // The frame carries the stored matrix' shape (DCM2); a legacy DCM1 frame has none, and
    // there the window WAS the whole matrix.
    totalRows = frame.totalRows ?? rows;
    // An empty result matrix is a legitimate state (an erroring node clears its output);
    // reading past it must stop, not spin the row counter forward.
    if (data.length === 0) break;
    if (fetched === 0) names = frame.names ?? [];
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
  return { matrix, shownRows: fetched, totalRows: Math.max(totalRows, fetched), truncated };
}

/** Store a fetched result in the card's display cache and record how much of it we hold. */
function applyResultCache(cardId: number, result: ResultFetch): void {
  useWorkspace.setState((state) => {
    const current = state.cards.find((c) => c.id === cardId);
    if (!current || !isFormulaCard(current)) return {};
    const matrices = new Map(state.matrices);
    matrices.set(current.displayMatrixId, result.matrix);
    const cards = state.cards.map((card) =>
      card.id === cardId && isFormulaCard(card)
        ? {
            ...card,
            result: {
              totalRows: result.totalRows,
              shownRows: result.shownRows,
              complete: result.shownRows >= result.totalRows,
              truncated: result.truncated,
            },
          }
        : card,
    );
    return { matrices, cards };
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
 * Concurrent pulls of the same card are collapsed: create + event + PATCH used to trigger
 * three identical full-table downloads of the same result.
 */
const pullsInFlight = new Map<number, Promise<void>>();

async function pullPreviewIntoCache(cardId: number): Promise<void> {
  const card = useWorkspace.getState().cards.find((c) => c.id === cardId);
  if (!card || !isFormulaCard(card)) return;
  const output = card.outputs[0];
  if (!output || output.resultMatrixId < 0) return;

  // A `done` event means the numbers may have changed, so the cache is always refreshed —
  // but how much is refreshed follows the user's last choice: a card the user expanded with
  // "show more" keeps mirroring the whole table instead of collapsing back to the preview.
  const budget = card.result?.complete ? MAX_CACHE_ROWS : RESULT_PREVIEW_ROWS;
  const result = await fetchResultRows(output.resultMatrixId, budget);
  if (!result) return;
  applyResultCache(cardId, result);
}

/**
 * Pull a done node's result into the card's display cache (first screenful).
 *
 * The backend returns the whole wide table (one column per expression) with the expression
 * names attached as annotations, so the browser-side per-column merge and its cache slots
 * are gone. I/O is paged (see `fetchResultRows`); this function only decides where it goes.
 */
async function pullResultIntoCache(cardId: number): Promise<void> {
  const inflight = pullsInFlight.get(cardId);
  if (inflight) return inflight;
  const task = pullPreviewIntoCache(cardId).finally(() => {
    pullsInFlight.delete(cardId);
    // A chart may have asked for the full column while the preview was in flight.
    ensureChartData(cardId);
  });
  pullsInFlight.set(cardId, task);
  return task;
}

/** Fetch the WHOLE result into the display cache ("show more"). */
async function loadFullResultIntoCache(cardId: number): Promise<void> {
  const inflight = pullsInFlight.get(cardId);
  if (inflight) return inflight;
  const task = (async () => {
    const card = useWorkspace.getState().cards.find((c) => c.id === cardId);
    if (!card || !isFormulaCard(card)) return;
    const output = card.outputs[0];
    if (!output || output.resultMatrixId < 0) return;
    if (card.result?.complete) return;
    const result = await fetchResultRows(output.resultMatrixId, MAX_CACHE_ROWS);
    if (!result) return;
    applyResultCache(cardId, result);
  })().finally(() => pullsInFlight.delete(cardId));
  pullsInFlight.set(cardId, task);
  return task;
}

/**
 * Charts need the whole column — a curve drawn from a 100-row preview would silently show
 * a fraction of the data. So a chart dependent pulls the full result instead of the preview.
 * (An explicit user action — "open a chart from this output" — is what makes paying for the
 * whole table correct.)
 */
function ensureChartData(ownerCardId: number): void {
  const state = useWorkspace.getState();
  const owner = state.cards.find((c) => c.id === ownerCardId);
  if (!owner || !isFormulaCard(owner) || owner.result?.complete) return;
  const dependents = state.dependencies.getDependents(ownerCardId);
  const needsFull = dependents.some((id) => {
    const card = state.cards.find((c) => c.id === id);
    return card ? isChartCard(card) : false;
  });
  if (needsFull) void loadFullResultIntoCache(ownerCardId);
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
 * Does anything in the workspace still read this matrix?
 *
 * The one rule behind every "is it safe to drop this parse" decision: a source slot, a
 * chart column, a function card's frozen input, or a function card's display cache. The
 * identity cache is deliberately *not* a reference — it is a parse accelerator, and keeping
 * a matrix alive for it would leak one parse per replaced file.
 */
function isMatrixReferenced(cards: CardModel[], matrixId: number): boolean {
  for (const card of cards) {
    if (isMatrixCard(card)) {
      if (card.sources.some((source) => source.matrixId === matrixId)) return true;
    } else if (isChartCard(card)) {
      if (card.config.sources.some((source) => source.matrixId === matrixId)) return true;
      if (card.config.xAxisSource?.matrixId === matrixId) return true;
    } else if (isFormulaCard(card)) {
      if (card.displayMatrixId === matrixId) return true;
      if (card.inputs.some((input) => input.target.matrixId === matrixId)) return true;
    }
  }
  return false;
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
      // The port id travels with the edge: it is the identity the connection layer
      // anchors on, and it is already on the envelope — no per-kind knowledge needed.
      if (dependencies.addDependency(card.id, target, input.portId)) droppedEdges += 1;
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
   *
   * `retiredMatrixIds` covers file *replacement*: the old matrix is no longer one of the
   * card's slots, but a chart may still hold it, and that chart must follow the new file
   * exactly like a switch does. Only this card's dependents are visited, so a matrix that
   * is also a source of another card is never re-pointed behind that card's back.
   */
  const refreshDependentsOf = (
    ownerCardId: number,
    retiredMatrixIds: readonly number[] = [],
  ): void => {
    const state = get();
    const owner = state.cards.find((c) => c.id === ownerCardId);
    if (!owner) return;

    // A formula card's display cache may hold only the first screenful; charts read the
    // whole column, so a chart dependent upgrades the cache before it re-points.
    if (isFormulaCard(owner)) ensureChartData(ownerCardId);

    // A data card re-points dependents at its newly active file; a function card has one
    // output table, so dependents simply re-read it.
    let activeMatrixId: number | undefined;
    let matrixIds: Set<number>;
    if (isMatrixCard(owner)) {
      activeMatrixId = owner.sources[owner.activeSource]?.matrixId;
      matrixIds = new Set(owner.sources.map((source) => source.matrixId));
      for (const retired of retiredMatrixIds) matrixIds.add(retired);
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
      const raw = column.data.slice();
      return {
        ...source,
        matrixId: activeMatrixId,
        raw,
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
   * Resolve local matrix ids for freshly parsed files.
   *
   * The byte-identity cache is reused rather than re-parsed (the same bytes opened twice
   * share one matrix), but sharing is always *read-only*: a later replacement hands the
   * changed card a fresh id instead of writing through the alias. That is what makes
   * `replaceCardSources` safe with two cards that happen to hold the same file.
   */
  const allocateMatrices = (
    entries: MatrixEntry[],
  ): {
    matrices: Map<number, MatrixData>;
    matrixIdByIdentity: Map<string, number>;
    nextMatrixId: number;
    ids: number[];
  } => {
    const state = get();
    const matrices = new Map(state.matrices);
    const matrixIdByIdentity = new Map(state.matrixIdByIdentity);
    let nextMatrixId = state.nextMatrixId;
    const ids: number[] = [];

    for (const entry of entries) {
      const key = entry.identity ? identityKey(entry.identity) : null;
      const existing = key !== null ? matrixIdByIdentity.get(key) : undefined;
      if (existing !== undefined && matrices.has(existing)) {
        ids.push(existing);
        continue;
      }
      const matrixId = nextMatrixId++;
      matrices.set(matrixId, entry.matrix);
      if (key !== null) matrixIdByIdentity.set(key, matrixId);
      ids.push(matrixId);
    }

    return { matrices, matrixIdByIdentity, nextMatrixId, ids };
  };

  /**
   * Upload one local table to the backend, coalescing concurrent attempts.
   *
   * Fire-and-forget like the original inline block: a file load must never wait on the
   * network, and a failure flips the banner (`registerMatrixWithBackend` does that). The
   * workspace generation is captured so an upload that started before a `reset` /
   * `loadSnapshot` cannot bind its server id to an id that now names different bytes —
   * the server copy is released instead.
   */
  const registerUploadedMatrix = (
    matrixId: number,
    name: string,
    matrix: MatrixData,
  ): Promise<number | null> => {
    const inFlight = matrixUploads.get(matrixId);
    if (inFlight) return inFlight;

    const epoch = workspaceEpoch;
    const columns = matrix.columns().map((column) => ({
      posName: column.posName,
      annotation: column.annotation,
      data: column.data,
    }));
    const task = get()
      .registerMatrixWithBackend(name, columns)
      .then((serverId) => {
        if (serverId === null) return null;
        if (epoch !== workspaceEpoch || !get().matrices.has(matrixId)) {
          // The workspace was replaced while this upload ran: the local id now means
          // something else (or nothing), so the server copy has no reader.
          void backendClient.deleteMatrix(serverId);
          return null;
        }
        backendMatrixIds.set(matrixId, serverId);
        // A function card created while this table was still uploading has been waiting
        // for exactly this id; nothing else retries its binding.
        syncUnboundReadersOfMatrix(matrixId);
        return serverId;
      })
      .finally(() => {
        matrixUploads.delete(matrixId);
      });
    matrixUploads.set(matrixId, task);
    return task;
  };

  /**
   * Drop a local matrix once nothing reads it, including its server-side copy.
   *
   * Called after every operation that can orphan a parse (file replacement, a function
   * card applying a re-point). The guard is `isMatrixReferenced`, so a matrix that is
   * still a source slot, a chart column, or a frozen function input survives — including
   * the shared-parse case, where another card still points at the same id.
   */
  const pruneMatrixIfUnreferenced = (matrixId: number): void => {
    const state = get();
    if (!state.matrices.has(matrixId)) return;
    if (isMatrixReferenced(state.cards, matrixId)) return;

    const matrices = new Map(state.matrices);
    matrices.delete(matrixId);
    const matrixIdByIdentity = new Map(state.matrixIdByIdentity);
    for (const [key, id] of matrixIdByIdentity) {
      if (id === matrixId) matrixIdByIdentity.delete(key);
    }
    // Release the server-side copy too, otherwise the backend grows without bound as a
    // template is re-filled with fresh data. The id is dropped first so a later reconnect
    // cannot hand out an id the server no longer has.
    const backendId = backendMatrixIds.get(matrixId);
    if (backendId !== undefined) {
      backendMatrixIds.delete(matrixId);
      void backendClient.deleteMatrix(backendId);
    }
    set({ matrices, matrixIdByIdentity });
  };

  /**
   * Re-point every function card that reads one of `oldToNew`'s keys.
   *
   * This is the *data* half of a file replacement: the card's input is frozen to an
   * explicit matrix (v2), so it must be rewritten when that matrix's bytes are replaced —
   * but it is rewritten to the corresponding new matrix of the *same card*, never to
   * "whatever it shows now". Returns the affected card ids so the caller can PATCH them
   * once the new matrices have server ids.
   */
  const repointReadersOf = (ownerCardId: number, oldToNew: Map<number, number>): number[] => {
    if (oldToNew.size === 0) return [];
    const state = get();
    const affected: number[] = [];
    const cards = state.cards.map((card) => {
      if (!isFormulaCard(card)) return card;
      let changed = false;
      const inputs = card.inputs.map((input) => {
        if (input.target.cardId !== ownerCardId) return input;
        const nextMatrixId = oldToNew.get(input.target.matrixId);
        if (nextMatrixId === undefined) return input;
        changed = true;
        return { ...input, target: { ...input.target, matrixId: nextMatrixId } };
      });
      if (!changed) return card;
      affected.push(card.id);
      return { ...card, inputs };
    });
    if (affected.length > 0) set({ cards });
    return affected;
  };

  /**
   * Register every uploaded table the server has not seen yet, then re-push function cards.
   *
   * Nothing else retries a registration that failed while the backend was down, so without
   * this a table loaded (or a file replaced) during an outage would leave its function
   * cards bound to the old numbers forever — with no banner once the connection is back.
   */
  const ensureUploadedMatricesRegistered = async (): Promise<void> => {
    const derivedIds = new Set(
      get()
        .cards.filter(isFormulaCard)
        .map((card) => card.displayMatrixId),
    );
    const ordered = [...get().matrices.entries()]
      .filter(([localId]) => !derivedIds.has(localId) && !backendMatrixIds.has(localId))
      .sort((a, b) => a[0] - b[0]);
    for (const [localId, matrix] of ordered) {
      await registerUploadedMatrix(localId, `#${localId}`, matrix);
    }
    for (const card of get().cards) {
      if (isFormulaCard(card)) void syncFunctionCard(card.id);
    }
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
    const portsFor = (ownerId: number): string[] =>
      nextInputs.filter((input) => input.target.cardId === ownerId).map((input) => input.portId);
    for (const ownerId of afterOwners) {
      if (beforeOwners.has(ownerId)) continue;
      const cycle = state.dependencies.addDependency(cardId, ownerId, portsFor(ownerId));
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
    // A surviving owner can still have its port set rewritten (a column was added to or
    // removed from the chart without changing who owns it), so re-sync the set instead of
    // only appending to it.
    for (const ownerId of afterOwners) {
      state.dependencies.removeDependency(cardId, ownerId);
      state.dependencies.addDependency(cardId, ownerId, portsFor(ownerId));
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
    helpOpen: false,
    helpSection: null,
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
      const allocated = allocateMatrices(entries);
      const sources = allocated.ids.map((matrixId, index) => ({
        name: entries[index].name,
        matrixId,
      }));
      // Register server-side too (B-plan: the backend holds the authoritative copy).
      // Fire-and-forget: file loading must never wait on the network; a failed
      // registration flips `backend` to offline and the banner appears.
      for (let index = 0; index < entries.length; ++index) {
        void registerUploadedMatrix(allocated.ids[index], entries[index].name, entries[index].matrix);
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
        matrices: allocated.matrices,
        matrixIdByIdentity: allocated.matrixIdByIdentity,
        nextCardId: cardId + 1,
        nextMatrixId: allocated.nextMatrixId,
        selectedId: cardId,
      });
      revealCard({ ...matrixSpot, ...matrixSize });
      return cardId;
    },

    /**
     * A data card's file change — the operation the card never had.
     *
     * Deliberately NOT "mutate the matrix in place": two cards may share one parse
     * (`allocateMatrices`), and writing through that alias would change the other card's
     * numbers. Every replacement therefore allocates a new local id and moves this card's
     * own references onto it; the old matrix is released only once nothing reads it.
     */
    replaceCardSources(cardId, entries, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isMatrixCard(card)) return false;
      if (entries.length === 0) return false;
      if (index !== undefined) {
        // The UI's「替换文件…」control always acts on the file the card is showing; a
        // replacement of a hidden slot would change numbers the user cannot see.
        if (index !== card.activeSource || index < 0 || index >= card.sources.length) {
          return false;
        }
        if (entries.length !== 1) return false;
      }

      const allocated = allocateMatrices(entries);
      const previous = card.sources;
      const nextSources =
        index === undefined
          ? entries.map((entry, entryIndex) => ({
              name: entry.name,
              matrixId: allocated.ids[entryIndex],
            }))
          : previous.map((source, sourceIndex) =>
              sourceIndex === index
                ? { name: entries[0].name, matrixId: allocated.ids[0] }
                : source,
            );

      // Old → new: which matrix each formula card's frozen input must move to. The button
      // path replaces one slot, so the pairing is explicit; a drop replaces the whole set,
      // so it pairs by slot order and sends any unpaired old slot to the new first file
      // (the card now holds this set of files and nothing else).
      const oldToNew = new Map<number, number>();
      if (index === undefined) {
        const activeId = allocated.ids[0];
        previous.forEach((source, sourceIndex) => {
          const target = allocated.ids[sourceIndex] ?? activeId;
          if (!oldToNew.has(source.matrixId) && source.matrixId !== target) {
            oldToNew.set(source.matrixId, target);
          }
        });
      } else if (previous[index].matrixId !== allocated.ids[0]) {
        oldToNew.set(previous[index].matrixId, allocated.ids[0]);
      }

      // Names stay unique inside one card, otherwise the file selector shows two identical
      // entries and the user cannot tell which file they are looking at.
      const taken = new Set<string>();
      const deduped = nextSources.map((source) => {
        let name = source.name;
        if (taken.has(name)) {
          const dot = source.name.lastIndexOf('.');
          let counter = 2;
          while (taken.has(name)) {
            name =
              dot > 0
                ? `${source.name.slice(0, dot)} (${counter})${source.name.slice(dot)}`
                : `${source.name} (${counter})`;
            counter += 1;
          }
        }
        taken.add(name);
        return { ...source, name };
      });

      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId && isMatrixCard(entry)
            ? {
                ...entry,
                sources: deduped,
                activeSource: index === undefined ? 0 : index,
              }
            : entry,
        ),
        matrices: allocated.matrices,
        matrixIdByIdentity: allocated.matrixIdByIdentity,
        nextMatrixId: allocated.nextMatrixId,
        // A pending offer names a matrix that no longer means what it used to; the
        // replacement is the newer intent.
        repointOffers: state.repointOffers.filter(
          (offer) =>
            !oldToNew.has(offer.fromMatrixId) && !oldToNew.has(offer.toMatrixId),
        ),
      });

      // Charts are views: they follow the file the card now shows.
      refreshDependentsOf(cardId, [...oldToNew.keys()]);
      // Function cards are frozen references: re-point the ones that read the replaced
      // matrix, then push them once the new content has a server-side id.
      const readers = repointReadersOf(cardId, oldToNew);
      const uploads: Array<Promise<number | null>> = [];
      for (let entryIndex = 0; entryIndex < entries.length; ++entryIndex) {
        const matrixId = allocated.ids[entryIndex];
        if (backendMatrixIds.has(matrixId)) continue;
        uploads.push(registerUploadedMatrix(matrixId, entries[entryIndex].name, entries[entryIndex].matrix));
      }
      // The replaced matrices are already unreferenced *locally*, but their server copies
      // are still bound by the function nodes until the re-point PATCHes land — deleting
      // them now would be refused (409) and leave the copy behind anyway. So the local
      // parse goes immediately, and the server copy goes once the readers have re-bound.
      const retiredServerIds: number[] = [];
      for (const retiredId of oldToNew.keys()) {
        const serverId = backendMatrixIds.get(retiredId);
        if (serverId !== undefined) {
          backendMatrixIds.delete(retiredId);
          retiredServerIds.push(serverId);
        }
        // Nothing reads the replaced matrices any more unless a card elsewhere shared the
        // parse or a function card was left alone; in that case they stay alive.
        pruneMatrixIfUnreferenced(retiredId);
      }

      const syncReaders = async () => {
        await Promise.all(readers.map((readerId) => syncFunctionCard(readerId)));
        // The re-point must be ON THE SERVER before the old copy is released, otherwise
        // the backend refuses the delete (409) and the copy stays behind anyway.
        await waitForCardPushes();
        for (const serverId of retiredServerIds) releaseServerMatrix(serverId);
      };
      if (uploads.length === 0) void syncReaders();
      else void Promise.all(uploads).then(() => syncReaders());
      return true;
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
        const ports = card.inputs
          .filter((input) => input.target.cardId === ownerId)
          .map((input) => input.portId);
        const cycle = state.dependencies.addDependency(cardId, ownerId, ports);
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
        // The display cache is never a registered source, so a stale entry here could only
        // come from a future change; dropping it keeps the map honest either way.
        backendMatrixIds.delete(card.displayMatrixId);
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
        // An offer names a card that no longer exists; keeping it would leave a banner
        // pointing at nothing (and `applyRepoint` would silently do nothing).
        repointOffers: state.repointOffers.filter(
          (offer) => offer.cardId !== id && offer.ownerCardId !== id,
        ),
        selectedId: state.selectedId === id ? null : state.selectedId,
        blockedCardId: state.blockedCardId === id ? null : state.blockedCardId,
      });
      return true;
    },

    closeAllCards() {
      const state = get();
      // The backend has no way to notice that the user closed a card, so "close all" has to
      // say so: release every node, then every uploaded table. Skipping this left the whole
      // compute graph behind, and a reopened workspace inherited nodes that still read the
      // old matrices — those leaks also refuse the `DELETE /api/matrices` a file
      // replacement needs. Nodes go first and are awaited: a matrix cannot be deleted while
      // one of them reads it.
      const nodeIds: number[] = [];
      const serverMatrixIds: number[] = [];
      for (const card of state.cards) {
        if (isFormulaCard(card)) {
          const nodeId = card.node?.nodeId ?? -1;
          if (nodeId > 0) nodeIds.push(nodeId);
        } else if (isMatrixCard(card)) {
          for (const source of card.sources) {
            const serverId = backendMatrixIds.get(source.matrixId);
            if (serverId !== undefined) {
              backendMatrixIds.delete(source.matrixId);
              serverMatrixIds.push(serverId);
            }
          }
        }
      }
      matrixUploads.clear();
      void (async () => {
        // A push that started before the close may still create a node; it deletes its own
        // node when it notices the card is gone, so wait for it before releasing matrices.
        await waitForCardPushes();
        for (const nodeId of nodeIds) await backendClient.deleteNode(nodeId);
        for (const serverId of serverMatrixIds) releaseServerMatrix(serverId);
      })();
      set({
        cards: [],
        matrices: new Map(),
        matrixIdByIdentity: new Map(),
        selectedId: null,
        blockedCardId: null,
        blockNonce: state.blockNonce + 1,
        dependencies: new DependencyGraph(),
        repointOffers: [],
      });
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
      // A table or a function card's output can both feed a function card: the result of
      // one card is an ordinary matrix, which is what makes chains (A → B → C) a graph
      // rather than a fan-out from the tables. The backend already treats result matrices
      // as mid-edges, so a chain recomputes in one pass.
      if (!sourceCard || isChartCard(sourceCard)) return null;
      // v2: the reference is ONE explicit matrix. Without an explicit id the card captures
      // what the source shows right now — and keeps reading it afterwards.
      const targetMatrixId =
        matrixId ?? (isMatrixCard(sourceCard) ? sourceCard.sources[sourceCard.activeSource]?.matrixId : undefined) ??
        (isFormulaCard(sourceCard) ? sourceCard.displayMatrixId : undefined);
      if (targetMatrixId === undefined) return null;
      const ownedMatrixIds = isMatrixCard(sourceCard)
        ? sourceCard.sources.map((entry) => entry.matrixId)
        : [sourceCard.displayMatrixId];
      if (!ownedMatrixIds.includes(targetMatrixId)) return null;
      const sourceMatrix = state.matrices.get(targetMatrixId);
      if (!sourceMatrix) return null;

      const cardId = state.nextCardId;
      const displayMatrixId = state.nextMatrixId;

      // Start with one expression referencing the first column. The identifier must be
      // the label the backend resolves against — annotation when present, else Pos.N — not
      // the raw posName: `Pos.1 * 2` fails on a table whose first column is annotated `A`.
      const firstColLabel =
        sourceMatrix.columnCount() > 0 ? sourceColumnLabel(sourceMatrix.column(0)) : 'A';
      // The label is what the user reads; the reference is what the engine can parse. They
      // differ for names containing `/` or spaces — the default must be a working formula,
      // not a demonstration of the failure.
      const firstColReference =
        sourceMatrix.columnCount() > 0 ? formulaReference(sourceMatrix.column(0)) : 'A';
      const formulas = [{ name: `${firstColLabel} × 2`, expression: `${firstColReference} * 2` }];

      // The display cache starts EMPTY. It is filled only once the backend reports the node
      // `done` and we pull its result window — the browser computes nothing
      // (docs/decisions/2026-10-17-backend-owns-compute.md).
      const matrices = new Map(state.matrices);
      matrices.set(displayMatrixId, new MatrixData());

      // Roomy on purpose: the three-zone card is the thing users cannot find their way
      // around, and at 520×380 the formula rows, the result grid and the help affordances
      // fought over ~350 px of body. 640×480 also gives the 可用列 rail a second column.
      const formulaSize = { width: 640, height: 480 };
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
        result: null,
        displayMatrixId,
      };

      const cycle = state.dependencies.addDependency(
        cardId,
        sourceCardId,
        inputs.map((input) => input.portId),
      );
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

      const formulas = (card.params.formulas ?? []).slice();
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
      const current = card.params.formulas ?? [];
      if (current.length <= 1) return; // keep at least one

      const formulas = current.filter((_, i) => i !== index);

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

    addRelationEnumCard(sourceCardId, columnIndex) {
      const state = get();
      const sourceCard = state.cards.find((c) => c.id === sourceCardId);
      if (!sourceCard || isChartCard(sourceCard)) return null;
      const matrixId = chartSourceMatrixId(sourceCard);
      if (matrixId === null) return null;
      const matrix = state.matrices.get(matrixId);
      if (!matrix) return null;
      // A relation needs two columns to relate. The clicked column is `x`; `y` is its
      // neighbour (previous one at the right edge) — the card's own port selectors then
      // take over, so this default is a starting point rather than a rule.
      if (matrix.columnCount() < 2) return null;
      if (columnIndex < 0 || columnIndex >= matrix.columnCount()) return null;
      const yIndex = columnIndex + 1 < matrix.columnCount() ? columnIndex + 1 : columnIndex - 1;

      const inputs: PortConnection[] = [
        {
          portId: REGRESSION_PORT_X,
          target: { type: 'cell', cardId: sourceCardId, matrixId, column: columnIndex },
        },
        {
          portId: REGRESSION_PORT_Y,
          target: { type: 'cell', cardId: sourceCardId, matrixId, column: yIndex },
        },
      ];
      const cardId = state.nextCardId;
      const size = { width: 480, height: 320 };
      const spot = placeOnPlane(
        { x: sourceCard.x + sourceCard.width + 32, y: sourceCard.y + 40 },
        size,
        state.cards,
      );
      const card: FunctionCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        ...spot,
        width: size.width,
        height: size.height,
        z: topZ() + 1,
        createdAt: Date.now(),
        inputs,
        signatureId: REGRESSION_SIGNATURE,
        // Payload-free params: a regression has no expressions, which is exactly the case
        // the card UI must handle without showing a formula editor.
        params: {},
        outputs: [{ outputId: 'fit', resultMatrixId: -1 }],
        node: null,
        result: null,
        displayMatrixId: state.nextMatrixId,
      };
      const cycle = state.dependencies.addDependency(
        cardId,
        sourceCardId,
        inputs.map((input) => input.portId),
      );
      if (cycle) {
        // A regression reads two columns of its source, so the edge is the same shape as an
        // expression card's — and a refused edge must not leave a card with no dependency.
        get().showToast(
          'error',
          translatorFor(get().locale)('status.cycle', { path: cycle.join(' → ') }),
        );
        return null;
      }
      set({
        cards: [...state.cards, card],
        dependencies: state.dependencies,
        nextCardId: cardId + 1,
        nextMatrixId: state.nextMatrixId + 1,
        selectedId: cardId,
      });
      revealCard({ ...spot, ...size });
      void syncFunctionCard(cardId);
      return cardId;
    },

    setPortColumn(cardId, portId, columnIndex) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      const input = card.inputs.find((entry) => entry.portId === portId);
      if (!input || input.target.type !== 'cell') return;
      const matrix = state.matrices.get(input.target.matrixId);
      if (!matrix || columnIndex < 0 || columnIndex >= matrix.columnCount()) return;
      if (input.target.column === columnIndex) return;

      // Only the column changes: same card, same node, same edge. The column is a BINDING
      // (data flow), never a parameter — `params` stays empty for this signature.
      const inputs = card.inputs.map((entry): PortConnection => {
        if (entry.portId !== portId || entry.target.type !== 'cell') return entry;
        return {
          ...entry,
          target: {
            type: 'cell',
            cardId: entry.target.cardId,
            matrixId: entry.target.matrixId,
            column: columnIndex,
          },
        };
      });
      set({
        cards: state.cards.map((entry) =>
          entry.id === cardId ? { ...entry, inputs } : entry,
        ),
      });
      void syncFunctionCard(cardId);
    },

    refreshDependentsOf(cardId) {
      refreshDependentsOf(cardId);
    },

    loadFullResult(cardId) {
      void loadFullResultIntoCache(cardId);
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
      // The old matrix is released only after that PATCH settles — the server refuses a
      // DELETE while the node still reads it (and the browser logs the 409).
      void (async () => {
        try {
          await syncFunctionCard(cardId);
        } catch {
          // The banner already carries an unreachable backend; the local prune below is
          // still correct because nothing in the workspace reads the old matrix any more.
        }
        await waitForCardPushes();
        pruneMatrixIfUnreferenced(offer.fromMatrixId);
      })();
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
      void (async () => {
        try {
          await Promise.all([...byCard.keys()].map((cardId) => syncFunctionCard(cardId)));
        } catch {
          // Same as above: freeing the old parses does not depend on the network.
        }
        await waitForCardPushes();
        for (const offer of targets) pruneMatrixIfUnreferenced(offer.fromMatrixId);
      })();
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
      // Only expression-shaped signatures name their columns positionally; a signature
      // that fixes its own output names has nothing to rename.
      const formulas = card.params.formulas?.slice();
      if (!formulas) return;
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

    // ── help dialog ───────────────────────────────────────────────────

    openHelp(section) {
      // Without a section the dialog opens at the top; an explicit one scrolls there.
      set({ helpOpen: true, helpSection: section ?? null });
    },

    closeHelp() {
      set({ helpOpen: false, helpSection: null });
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
        // Tables loaded (or files replaced) while the backend was down have no server id,
        // and nothing else retries them: upload them now and re-push the function cards.
        void ensureUploadedMatricesRegistered();
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
      // A push started against the previous workspace must not bind into this one.
      workspaceEpoch += 1;
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
        // A function card's display cache is a *derived* view: its numbers come from the
        // node's result matrix server-side. Registering it as a source would create a
        // duplicate table that nothing reads (and leak one per restore).
        const derivedIds = new Set(
          restored.filter(isFormulaCard).map((card) => card.displayMatrixId),
        );
        const ordered = [...matrices.entries()]
          .filter(([localId]) => !derivedIds.has(localId))
          .sort((a, b) => a[0] - b[0]);
        for (const [localId, matrix] of ordered) {
          if (backendMatrixIds.has(localId)) continue;
          await registerUploadedMatrix(localId, `#${localId}`, matrix);
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
      // A coalesced re-run queued before the reset would otherwise target the *new* card
      // that inherits the same id.
      syncingCards.clear();
      resyncRequested.clear();
      // Uploads started for the previous workspace must not bind their server ids to the
      // new workspace's local ids; `registerUploadedMatrix` releases the copy on settle.
      matrixUploads.clear();
      workspaceEpoch += 1;
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
        repointOffers: [],
        toast: null,
        // A reset returns the app to its initial state, including "no modal open".
        helpOpen: false,
        helpSection: null,
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
