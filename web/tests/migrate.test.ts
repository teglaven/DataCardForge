/**
 * Snapshot migration v1 → v2 (docs/decisions/2026-10-26-card-schema-v2.md).
 *
 * These tests pin the two behaviours the decision deliberately changed, so a future
 * refactor cannot quietly revert them:
 *   - a v1 formula card's input is FROZEN to the matrix it was reading at migration time
 *     (switching the table's file no longer re-points it);
 *   - the v1 per-column nodes collapse into ONE node whose state is the worst case.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { migrateWorkspace, WorkspaceFormatError } from '../src/ui/migrate.ts';
import { isChartCard, isFormulaCard, isMatrixCard, type FunctionCardModel } from '../src/ui/types.ts';

const store = () => useWorkspace.getState();

beforeEach(() => {
  store().reset();
});

/** A v1 workspace: one matrix card with two files, a chart, and a two-column formula card. */
function v1Snapshot() {
  return {
    version: 1,
    savedAt: '2026-10-20T00:00:00.000Z',
    cards: [
      {
        kind: 'matrix',
        id: 1,
        title: '',
        x: 10,
        y: 20,
        width: 640,
        height: 420,
        z: 1,
        createdAt: 1,
        sources: [
          { name: 'a.txt', matrixId: 10 },
          { name: 'b.txt', matrixId: 11 },
        ],
        activeSource: 1,
        readOnly: true,
      },
      {
        kind: 'chart',
        id: 2,
        title: '',
        x: 700,
        y: 20,
        width: 560,
        height: 400,
        z: 2,
        createdAt: 2,
        config: {
          type: 'line',
          sources: [{ matrixId: 10, columnIndex: 0, label: 'A', raw: [1, 2] }],
          xAxisSource: { matrixId: 10, columnIndex: 1, label: 'B', raw: [3, 4] },
          logScale: false,
          secondAxis: false,
          showFitLine: true,
          binCount: 0,
          errorKind: 'sd',
          layout: 'grouped',
          capWidth: 0.35,
        },
        smoothing: { mode: 'none', window: 1, alpha: 0.3, degree: 2 },
        columnPanelOpen: true,
      },
      {
        kind: 'formula',
        id: 3,
        title: '',
        x: 10,
        y: 500,
        width: 520,
        height: 380,
        z: 3,
        createdAt: 3,
        sourceCardId: 1,
        formulas: [
          { name: 'double', expression: 'A * 2' },
          { name: 'sum', expression: 'A + B' },
        ],
        resultMatrixId: 12,
        nodes: [
          { nodeId: 7, resultMatrixId: 20, state: 'done' },
          { nodeId: 8, resultMatrixId: 21, state: 'done' },
        ],
      },
    ],
    matrices: [
      { id: 10, name: 'a.txt', columns: [{ posName: 'Pos.1', annotation: 'A', data: [1, 2] }] },
      { id: 11, name: 'b.txt', columns: [{ posName: 'Pos.1', annotation: 'A', data: [10, 20] }] },
    ],
    nextCardId: 4,
    nextMatrixId: 13,
  };
}

describe('migrateWorkspace', () => {
  it('upgrades the envelope: version 2 and dependencies on every card', () => {
    const snapshot = migrateWorkspace(v1Snapshot());
    expect(snapshot.version).toBe(2);
    // A table is a data source: content, never an edge.
    const matrix = snapshot.cards.find(isMatrixCard)!;
    expect(matrix.inputs).toEqual([]);
  });

  it('derives chart inputs from the display config, with stable port ids', () => {
    const snapshot = migrateWorkspace(v1Snapshot());
    const chart = snapshot.cards.find(isChartCard)!;
    expect(chart.inputs.map((input) => input.portId)).toEqual(['src:10:0', 'x']);
    expect(chart.inputs[0].target).toEqual({
      type: 'cell',
      cardId: 1,
      matrixId: 10,
      column: 0,
    });
    expect(chart.inputs[1].target).toEqual({ type: 'cell', cardId: 1, matrixId: 10, column: 1 });
    // The display view survives untouched.
    expect(chart.config.sources).toHaveLength(1);
  });

  it('freezes a formula card onto ONE explicit matrix and one node', () => {
    const snapshot = migrateWorkspace(v1Snapshot());
    const fn = snapshot.cards.find(isFormulaCard)!;
    // activeSource was 1 ⇒ the frozen matrix is b.txt's (id 11), not "whatever is active".
    expect(fn.inputs).toEqual([
      { portId: 'src', target: { type: 'matrix', cardId: 1, matrixId: 11 } },
    ]);
    expect(fn.signatureId).toBe('builtin:expression-columns');
    expect(fn.params.formulas).toEqual([
      { name: 'double', expression: 'A * 2' },
      { name: 'sum', expression: 'A + B' },
    ]);
    // One output carrying the server matrix of the merged table (the first node's).
    expect(fn.outputs).toEqual([{ outputId: 'result', resultMatrixId: 20 }]);
    expect(fn.node).toEqual({ nodeId: 7, state: 'done' });
    // The v1 local display cache id becomes the v2 display cache id.
    expect(fn.displayMatrixId).toBe(12);
    // v1-only fields are gone.
    expect((fn as unknown as { nodes?: unknown }).nodes).toBeUndefined();
    expect((fn as unknown as { sourceCardId?: unknown }).sourceCardId).toBeUndefined();
  });

  it('collapses node states with the worst case winning', () => {
    const raw = v1Snapshot();
    const formula = raw.cards[2] as unknown as { nodes: Array<Record<string, unknown>> };
    formula.nodes = [
      { nodeId: 7, resultMatrixId: 20, state: 'done' },
      { nodeId: 8, resultMatrixId: 21, state: 'error', code: 'unknownColumn', params: { position: 2 } },
    ];
    const fn = migrateWorkspace(raw).cards.find(isFormulaCard)!;
    expect(fn.node).toEqual({
      nodeId: 8,
      state: 'error',
      code: 'unknownColumn',
      params: { position: 2 },
    });
  });

  it('keeps a card with no live node unregistered (null) instead of inventing one', () => {
    const raw = v1Snapshot();
    const formula = raw.cards[2] as unknown as { nodes: Array<Record<string, unknown> | null> };
    formula.nodes = [null, null];
    const fn = migrateWorkspace(raw).cards.find(isFormulaCard)!;
    expect(fn.node).toBeNull();
    expect(fn.outputs[0].resultMatrixId).toBe(-1);
  });

  it('passes a v2 workspace through unchanged', () => {
    const v2 = migrateWorkspace(v1Snapshot());
    const again = migrateWorkspace(v2);
    expect(again.cards).toEqual(v2.cards);
    expect(again.matrices).toEqual(v2.matrices);
  });

  it('refuses an unknown version', () => {
    expect(() => migrateWorkspace({ version: 99, cards: [], matrices: [] })).toThrow(
      WorkspaceFormatError,
    );
  });

  it('refuses a structurally broken file', () => {
    expect(() => migrateWorkspace({ version: 1, cards: [{}], matrices: [] })).toThrow(
      WorkspaceFormatError,
    );
    expect(() => migrateWorkspace({ version: 1, cards: [] })).toThrow(WorkspaceFormatError);
    expect(() => migrateWorkspace(null)).toThrow(WorkspaceFormatError);
  });

  it('is deterministic: the same v1 file yields the same v2 file', () => {
    const a = JSON.stringify(migrateWorkspace(v1Snapshot()));
    const b = JSON.stringify(migrateWorkspace(v1Snapshot()));
    expect(a).toBe(b);
  });
});

describe('restoring a migrated workspace', () => {
  it('rebuilds function-card dependencies from inputs[] (the old silent-loss bug)', () => {
    const snapshot = migrateWorkspace(v1Snapshot());
    store().loadSnapshot(snapshot);
    // The formula card used to lose its edge on reload, because rebuilding only looked at
    // chart cards. One pass over `inputs` keeps it.
    expect(store().dependencies.getDependents(1).sort()).toEqual([2, 3]);
    const fn = store().cards.find((c) => c.id === 3) as FunctionCardModel;
    expect(fn.inputs[0].target).toMatchObject({ matrixId: 11 });
  });

  it('drops a dangling edge instead of corrupting close-protection', () => {
    const snapshot = migrateWorkspace(v1Snapshot());
    const fn = snapshot.cards.find(isFormulaCard)!;
    fn.inputs = [{ portId: 'src', target: { type: 'matrix', cardId: 999, matrixId: 11 } }];
    store().loadSnapshot(snapshot);
    expect(store().dependencies.getDependents(1)).toEqual([2]);
  });
});
