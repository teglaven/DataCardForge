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

import { DependencyGraph } from '../core/DependencyGraph.ts';
import { MatrixData } from '../core/MatrixData.ts';
import { DEFAULT_SMOOTHING, type SmoothingOptions } from '../core/Smoothing.ts';
import { defaultChartConfig, type ChartConfig, type ChartSource } from '../charts/chartModel.ts';
import { chartTypeDef, minimumColumns, type ChartTypeId } from '../charts/chartTypes.ts';
import { lineColor } from '../charts/palette.ts';
import { evaluateExpression } from '../core/expression.ts';
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
  type WorkspaceSnapshot,
} from './types.ts';
import { createTranslator, detectLocale, type Locale, type MessageKey } from './i18n.ts';

export { lineColor };

/**
 * Display label for a column: the file's annotation when present, otherwise `Pos.N`.
 * Shared by every place that materialises a `ChartSource`.
 */
function columnLabel(column: { posName: string; annotation: string }): string {
  return column.annotation !== '' ? `${column.posName} ${column.annotation}` : column.posName;
}

/** Minimum card footprint, in px (the Qt cards had a 300×200 minimum). */
export const MIN_CARD_WIDTH = 280;
export const MIN_CARD_HEIGHT = 180;

/** Deliberately coarse epsilon: float noise from drag/resize must not re-render. */
const GEOM_EPSILON = 0.01;

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
  /** Add or update a formula column. Recomputes the result matrix. */
  setFormula: (cardId: number, index: number, name: string, expression: string) => void;
  /** Remove a formula column. */
  removeFormula: (cardId: number, index: number) => void;
  /** Force recompute of a formula card's result matrix. */
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

  // ── persistence ─────────────────────────────────────────────────────
  toSnapshot: () => WorkspaceSnapshot;
  loadSnapshot: (snapshot: WorkspaceSnapshot) => void;
  /** Return the store to its initial state (used by tests and "close all"). */
  reset: () => void;
}

let toastCounter = 0;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < GEOM_EPSILON;
}

/**
 * Evaluate a set of formula expressions against a source matrix and return the result
 * as a new MatrixData. Each formula produces one column in the output.
 */
function computeFormulaResult(
  source: MatrixData,
  formulas: Array<{ name: string; expression: string }>,
): MatrixData {
  const colNames = source.columns().map((c) => c.annotation || c.posName);
  const colData = source.columns().map((c) => c.data);
  const columns = colNames.map((name, i) => ({ name, data: colData[i] }));

  const result = new MatrixData();
  for (const formula of formulas) {
    try {
      const values = evaluateExpression(formula.expression, columns);
      result.appendColumn(formula.name, values);
    } catch {
      // Invalid expression — fill with NaN so the card still renders.
      const len = source.rowCount();
      result.appendColumn(formula.name, new Array<number>(len).fill(NaN));
    }
  }
  return result;
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Highest z currently in use, so new cards land on top. */
  const topZ = (): number =>
    get().cards.reduce((max, card) => Math.max(max, card.z), 0);

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

    set((current) => ({
      cards: current.cards.map((card) => {
        if (!isChartCard(card) || !dependentIds.has(card.id)) return card;

        let changed = false;
        const sources = card.config.sources.map((source) => {
          // Only sources that actually read this card's data are re-pointed.
          if (!matrixIds.has(source.matrixId)) return source;
          changed = true;
          // Column vanished in the new file: re-point but keep the old values so the
          // curve does not silently disappear.
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
        });

        return changed ? { ...card, config: { ...card.config, sources } } : card;
      }),
    }));
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
      }

      // Cascade placement, so stacked cards do not land exactly on top of each other.
      const offset = (state.cards.length % 8) * 28;
      const card: MatrixCardModel = {
        kind: 'matrix',
        id: cardId,
        title: '',
        x: 24 + offset,
        y: 24 + offset,
        width: 640,
        height: 420,
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
      const card: ChartCardModel = {
        kind: 'chart',
        id: cardId,
        title: '',
        // Offset from the source card so the new chart is visibly its child.
        x: matrixCard.x + matrixCard.width + 32,
        y: matrixCard.y + 24,
        width: 560,
        height: 400,
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
        get().showToast('error', `循环依赖：${cycle.join(' → ')}`);
        return null;
      }

      set({
        cards: [...state.cards, card],
        nextCardId: cardId + 1,
        selectedId: cardId,
      });
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
          }
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
            // Append unused columns in index order.
            const used = new Set(sources.map((source) => source.columnIndex));
            for (let index = 0; index < matrix.columnCount() && sources.length < needed; ++index) {
              if (used.has(index)) continue;
              const column = matrix.column(index);
              sources.push({
                matrixId,
                columnIndex: index,
                label: columnLabel(column),
                raw: column.data.slice(),
              });
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
          // A chart with no columns has nothing to draw; keep at least one.
          if (sources.length === 0) return card;
          return { ...card, config: { ...card.config, sources } };
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

      // Start with one empty formula referencing the first column.
      const firstColName = sourceMatrix.columnCount() > 0 ? sourceMatrix.column(0).posName : 'A';
      const formulas = [{ name: `${firstColName} × 2`, expression: `${firstColName} * 2` }];

      // Compute the initial result matrix.
      const resultMatrix = computeFormulaResult(sourceMatrix, formulas);

      const matrices = new Map(state.matrices);
      matrices.set(resultMatrixId, resultMatrix);

      const card: FormulaCardModel = {
        kind: 'formula',
        id: cardId,
        title: '',
        x: sourceCard.x + 40,
        y: sourceCard.y + sourceCard.height + 32,
        width: 520,
        height: 380,
        z: topZ() + 1,
        createdAt: Date.now(),
        sourceCardId,
        formulas,
        resultMatrixId,
      };

      state.dependencies.addDependency(cardId, sourceCardId);

      set({
        cards: [...state.cards, card],
        matrices,
        nextCardId: cardId + 1,
        nextMatrixId: resultMatrixId + 1,
        selectedId: cardId,
      });
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

      const sourceCard = state.cards.find((c) => c.id === card.sourceCardId);
      if (!sourceCard || !isMatrixCard(sourceCard)) return;
      const source = sourceCard.sources[sourceCard.activeSource];
      if (!source) return;
      const sourceMatrix = state.matrices.get(source.matrixId);
      if (!sourceMatrix) return;

      const resultMatrix = computeFormulaResult(sourceMatrix, formulas);
      const matrices = new Map(state.matrices);
      matrices.set(card.resultMatrixId, resultMatrix);

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c) ? { ...c, formulas } : c,
        ),
        matrices,
      });
    },

    removeFormula(cardId, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;
      if (card.formulas.length <= 1) return; // keep at least one

      const formulas = card.formulas.filter((_, i) => i !== index);

      const sourceCard = state.cards.find((c) => c.id === card.sourceCardId);
      if (!sourceCard || !isMatrixCard(sourceCard)) return;
      const source = sourceCard.sources[sourceCard.activeSource];
      if (!source) return;
      const sourceMatrix = state.matrices.get(source.matrixId);
      if (!sourceMatrix) return;

      const resultMatrix = computeFormulaResult(sourceMatrix, formulas);
      const matrices = new Map(state.matrices);
      matrices.set(card.resultMatrixId, resultMatrix);

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isFormulaCard(c) ? { ...c, formulas } : c,
        ),
        matrices,
      });
    },

    recomputeFormula(cardId) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isFormulaCard(card)) return;

      const sourceCard = state.cards.find((c) => c.id === card.sourceCardId);
      if (!sourceCard || !isMatrixCard(sourceCard)) return;
      const source = sourceCard.sources[sourceCard.activeSource];
      if (!source) return;
      const sourceMatrix = state.matrices.get(source.matrixId);
      if (!sourceMatrix) return;

      const resultMatrix = computeFormulaResult(sourceMatrix, card.formulas);
      const matrices = new Map(state.matrices);
      matrices.set(card.resultMatrixId, resultMatrix);

      set({ matrices });
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

      const cards = state.cards.map((card, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        return {
          ...card,
          x: pad + col * (cellWidth + gap),
          y: pad + row * (cellHeight + gap),
          width: cellWidth,
          height: cellHeight,
        };
      });
      set({ cards });
    },

    cascadeCards() {
      const state = get();
      const cards = state.cards.map((card, index) => ({
        ...card,
        x: 24 + index * 28,
        y: 24 + index * 28,
        z: index + 1,
      }));
      set({ cards });
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
        cards: snapshot.cards,
        matrices,
        matrixIdByIdentity: new Map(),
        dependencies,
        nextCardId: snapshot.nextCardId,
        nextMatrixId: snapshot.nextMatrixId,
        selectedId: null,
        blockedCardId: null,
        blockNonce: 1,
      });

      if (droppedEdges > 0) {
        get().showToast(
          'error',
          `工作区含 ${droppedEdges} 条循环依赖，已忽略（保存文件可能被手工编辑过）`,
        );
      }
    },

    reset() {
      set({
        cards: [],
        matrices: new Map(),
        matrixIdByIdentity: new Map(),
        selectedId: null,
        dependencies: new DependencyGraph(),
        blockedCardId: null,
        blockNonce: 0,
        toast: null,
        nextCardId: 1,
        nextMatrixId: 1,
      });
    },
  };
});

// ── Selectors ─────────────────────────────────────────────────────────────

export function useTranslator() {
  const locale = useWorkspace((s) => s.locale);
  const t = createTranslator(locale);
  return { t: (key: MessageKey, params?: Record<string, string | number>) => t(key, params), locale };
}

export function useCard(id: number): CardModel | undefined {
  return useWorkspace((s) => s.cards.find((c) => c.id === id));
}

export function useMatrix(matrixId: number): MatrixData | undefined {
  return useWorkspace((s) => s.matrices.get(matrixId));
}
