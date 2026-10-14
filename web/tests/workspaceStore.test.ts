/**
 * Workspace store behaviour.
 *
 * These tests lock in the interaction rules carried over from the Qt frontend:
 *   - one matrix card holds many files, switched by index,
 *   - a chart card is created from a column and registers a dependency,
 *   - switching the active file refreshes dependent charts,
 *   - a matrix with dependents cannot be closed,
 *   - everything round-trips through the workspace snapshot.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { isChartCard, isMatrixCard, type ChartCardModel, type MatrixCardModel } from '../src/ui/types.ts';

/**
 * Build a matrix from row-major data, mirroring how a text file is laid out.
 * Column-oriented storage is an internal detail, so tests express data as rows.
 */
function matrix(rows: number[][], annotations: string[] = []): MatrixData {
  const mat = new MatrixData();
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let c = 0; c < columnCount; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, rows.map((row) => row[c] ?? NaN));
    if (annotations[c]) mat.setColumnAnnotation(c, annotations[c]);
  }
  return mat;
}

const store = () => useWorkspace.getState();

beforeEach(() => {
  store().reset();
});

describe('addMatrixCard', () => {
  it('creates one card holding all given files', () => {
    const id = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1], [2]]) },
      { name: '2.txt', matrix: matrix([[3], [4]]) },
    ]);

    const card = store().cards.find((c) => c.id === id) as MatrixCardModel;
    expect(card.kind).toBe('matrix');
    expect(card.sources.map((s) => s.name)).toEqual(['1.txt', '2.txt']);
    expect(card.activeSource).toBe(0);
    expect(card.readOnly).toBe(true);
    expect(store().selectedId).toBe(id);
  });

  it('reuses a parse when the same bytes are opened again', () => {
    const identity = { size: 1024, lastModified: 1_700_000_000_000 };
    const first = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1], [2]]), identity },
    ]);
    const second = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1], [2]]), identity },
    ]);

    const a = store().cards.find((c) => c.id === first) as MatrixCardModel;
    const b = store().cards.find((c) => c.id === second) as MatrixCardModel;
    expect(b.sources[0].matrixId).toBe(a.sources[0].matrixId);
    expect(store().matrices.size).toBe(1);
  });

  it('does NOT reuse a parse for a different file that shares the name', () => {
    // The bug this locks out: `export.csv` overwritten daily. Keying the cache on the
    // file name returned yesterday's measurements under today's label — silently stale
    // data in a scientific tool. Identity is the bytes, never the label.
    const cardA = store().addMatrixCard([
      { name: 'export.csv', matrix: matrix([[1], [2]]), identity: { size: 100, lastModified: 1 } },
    ]);
    const cardB = store().addMatrixCard([
      { name: 'export.csv', matrix: matrix([[9], [9]]), identity: { size: 250, lastModified: 2 } },
    ]);

    const a = store().cards.find((c) => c.id === cardA) as MatrixCardModel;
    const b = store().cards.find((c) => c.id === cardB) as MatrixCardModel;
    expect(b.sources[0].matrixId).not.toBe(a.sources[0].matrixId);
    expect(store().matrices.size).toBe(2);
    // Each card keeps its own values.
    expect(store().matrices.get(b.sources[0].matrixId)!.cell(0, 0)).toBe(9);
    expect(store().matrices.get(a.sources[0].matrixId)!.cell(0, 0)).toBe(1);
  });

  it('treats an entry with no identity as unshareable', () => {
    // Programmatically built tables and restored snapshots have no backing bytes, so
    // they must not be deduplicated against each other by coincidence of name.
    store().addMatrixCard([{ name: 'x.txt', matrix: matrix([[1]]) }]);
    store().addMatrixCard([{ name: 'x.txt', matrix: matrix([[2]]) }]);
    expect(store().matrices.size).toBe(2);
  });

  it('places each new card at a different offset', () => {
    const a = store().addMatrixCard([{ name: 'a.txt', matrix: matrix([[1]]) }]);
    const b = store().addMatrixCard([{ name: 'b.txt', matrix: matrix([[1]]) }]);
    const cardA = store().cards.find((c) => c.id === a)!;
    const cardB = store().cards.find((c) => c.id === b)!;
    expect(cardB.x).not.toBe(cardA.x);
    expect(cardB.z).toBeGreaterThan(cardA.z);
  });
});

describe('addChartCard', () => {
  it('creates a chart from a column and registers the dependency', () => {
    const matrixId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2], [3, 4]], ['a', 'b']) },
    ]);
    const chartId = store().addChartCard(matrixId, 1)!;

    const card = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(card.kind).toBe('chart');
    expect(card.config.sources).toHaveLength(1);
    expect(card.config.sources[0].raw).toEqual([2, 4]);
    expect(card.config.sources[0].label).toBe('Pos.2 b');

    const matrixCard = store().cards.find((c) => c.id === matrixId) as MatrixCardModel;
    expect(matrixCard.sources[0].matrixId).toBe(1);
    // The dependency is registered against the matrix *card*, not the parsed matrix.
    expect(store().dependencies.getDependents(matrixId)).toEqual([chartId]);
  });

  it('refuses an out-of-range column', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    expect(store().addChartCard(cardId, 5)).toBeNull();
    expect(store().addChartCard(999, 0)).toBeNull();
  });
});

describe('setActiveSource refreshes dependent charts', () => {
  it('pushes the new file data into charts reading that matrix', () => {
    const cardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2], [3, 4]]) },
      { name: '2.txt', matrix: matrix([[10, 20], [30, 40]]) },
    ]);
    const chartId = store().addChartCard(cardId, 0)!;
    const before = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(before.config.sources[0].raw).toEqual([1, 3]);

    store().setActiveSource(cardId, 1);

    const after = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(after.config.sources[0].raw).toEqual([10, 30]);
  });

  it('keeps the old data when the column no longer exists', () => {
    const cardId = store().addMatrixCard([
      { name: 'wide.txt', matrix: matrix([[1, 2, 3], [4, 5, 6]]) },
      { name: 'narrow.txt', matrix: matrix([[7], [8]]) },
    ]);
    const chartId = store().addChartCard(cardId, 2)!;

    store().setActiveSource(cardId, 1);

    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    // Column 2 is gone in the narrow file: the line keeps its previous values but
    // follows the newly active matrix so a later switch back stays consistent.
    expect(chart.config.sources[0].raw).toEqual([3, 6]);
    expect(chart.config.sources[0].matrixId).toBe(2);
    expect(chart.config.sources[0].label).toBe('Pos.3');
  });

  it('ignores an invalid or unchanged index', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    store().setActiveSource(cardId, 0);
    store().setActiveSource(cardId, 99);
    const card = store().cards.find((c) => c.id === cardId) as MatrixCardModel;
    expect(card.activeSource).toBe(0);
  });
});

describe('close rules', () => {
  it('allows closing a matrix card that nothing depends on', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    expect(store().removeCard(cardId)).toBe(true);
    expect(store().cards).toHaveLength(0);
    expect(store().matrices.size).toBe(0);
  });

  it('refuses to close a matrix that still feeds a chart, and flags the block', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1, 2]]) }]);
    store().addChartCard(cardId, 0);
    const nonceBefore = store().blockNonce;

    expect(store().removeCard(cardId)).toBe(false);
    expect(store().cards).toHaveLength(2);
    expect(store().blockedCardId).toBe(cardId);
    expect(store().blockNonce).toBe(nonceBefore + 1);
  });

  it('allows the close once the dependent chart is gone', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1, 2]]) }]);
    const chartId = store().addChartCard(cardId, 0)!;

    expect(store().removeCard(chartId)).toBe(true);
    expect(store().removeCard(cardId)).toBe(true);
    expect(store().cards).toHaveLength(0);
    // The parsed matrix is released with its last owner.
    expect(store().matrices.size).toBe(0);
  });

  it('keeps a shared matrix alive until its last owning card closes', () => {
    // Two cards over the same bytes share one parsed matrix id.
    const identity = { size: 64, lastModified: 99 };
    const entries = () => [{ name: '1.txt', matrix: matrix([[1, 2]]), identity }];
    const first = store().addMatrixCard(entries());
    const second = store().addMatrixCard(entries());
    expect(store().matrices.size).toBe(1);

    expect(store().removeCard(first)).toBe(true);
    expect(store().matrices.size).toBe(1);

    expect(store().removeCard(second)).toBe(true);
    expect(store().matrices.size).toBe(0);
  });

  it('prunes the identity cache so re-dropping the file re-parses it', () => {
    const identity = { size: 64, lastModified: 99 };
    const first = store().addMatrixCard([
      { name: 'a.txt', matrix: matrix([[1]]), identity },
    ]);
    store().removeCard(first);

    // Same bytes again must NOT alias to the freed matrix.
    const again = store().addMatrixCard([
      { name: 'a.txt', matrix: matrix([[7]]), identity },
    ]);
    const card = store().cards.find((c) => c.id === again) as MatrixCardModel;
    expect(store().matrices.get(card.sources[0].matrixId)!.cell(0, 0)).toBe(7);
  });
});

describe('blockCard', () => {
  it('bumps the nonce so repeated refusals re-trigger the blink', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    const before = store().blockNonce;
    store().blockCard(cardId);
    store().blockCard(cardId);
    expect(store().blockNonce).toBe(before + 2);
    expect(store().selectedId).toBe(cardId);
  });
});

describe('setBounds', () => {
  it('clamps to the minimum card size', () => {
    const id = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    store().setBounds(id, { x: 5, y: 6, width: 10, height: 10 });
    const card = store().cards.find((c) => c.id === id)!;
    expect(card.x).toBe(5);
    expect(card.width).toBeGreaterThanOrEqual(280);
    expect(card.height).toBeGreaterThanOrEqual(180);
  });

  it('ignores sub-pixel noise so drag handlers cannot loop', () => {
    const id = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    const before = store().cards.find((c) => c.id === id)!;
    store().setBounds(id, {
      x: before.x + 0.001,
      y: before.y,
      width: before.width,
      height: before.height,
    });
    const after = store().cards.find((c) => c.id === id)!;
    expect(after).toBe(before); // identical object reference => no re-render
  });
});

describe('tile and cascade', () => {
  it('lays cards out in a grid that fits the viewport', () => {
    for (let i = 0; i < 4; ++i) {
      store().addMatrixCard([{ name: `${i}.txt`, matrix: matrix([[1]]) }]);
    }
    store().tileCards(1200, 800);
    const cards = store().cards;
    expect(new Set(cards.map((c) => `${c.x}:${c.y}`)).size).toBe(4);
    for (const card of cards) {
      expect(card.x + card.width).toBeLessThanOrEqual(1200);
      expect(card.y + card.height).toBeLessThanOrEqual(800);
    }
  });

  it('cascades with a fixed offset per card', () => {
    for (let i = 0; i < 3; ++i) {
      store().addMatrixCard([{ name: `${i}.txt`, matrix: matrix([[1]]) }]);
    }
    store().cascadeCards();
    const cards = store().cards;
    expect(cards[0].x).toBe(24);
    expect(cards[1].x).toBe(52);
    expect(cards[2].z).toBe(3);
  });
});

describe('snapshot round-trip', () => {
  it('restores cards, matrices and the dependency graph', () => {
    const cardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2], [3, 4]], ['a', 'b']) },
    ]);
    store().addChartCard(cardId, 0);
    store().setSmoothing(2, { mode: 'median', window: 5, alpha: 0.4, degree: 3 });

    const snapshot = store().toSnapshot();
    store().reset();
    expect(store().cards).toHaveLength(0);

    store().loadSnapshot(snapshot);

    expect(store().cards).toHaveLength(2);
    expect(store().matrices.size).toBe(1);

    const restoredMatrix = store().matrices.get(1)!;
    expect(restoredMatrix.cell(1, 1)).toBe(4);
    expect(restoredMatrix.column(1).annotation).toBe('b');

    const chart = store().cards.find((c) => isChartCard(c)) as ChartCardModel;
    expect(chart.config.sources[0].raw).toEqual([1, 3]);
    expect(chart.smoothing.mode).toBe('median');
    expect(chart.smoothing.window).toBe(5);

    // The dependency graph is rebuilt from the restored lines.
    const matrixCard = store().cards.find((c) => isMatrixCard(c)) as MatrixCardModel;
    expect(store().dependencies.getDependents(matrixCard.id)).toEqual([chart.id]);
  });

  it('serialises cleanly to JSON', () => {
    store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1.5, 2.5]]) }]);
    const text = JSON.stringify(store().toSnapshot());
    expect(text).not.toContain('Infinity');
    expect(JSON.parse(text).version).toBe(1);
  });
});

describe('map card keep-alive', () => {
  it('keeps read-only matrices as the single source of truth', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1, 2]]) }]);
    const card = store().cards.find((c) => c.id === cardId) as MatrixCardModel;
    expect(isMatrixCard(card)).toBe(true);
    const matrixId = card.sources[0].matrixId;
    expect(store().matrices.get(matrixId)!.cell(0, 1)).toBe(2);
  });
});
