/**
 * DependencyGraph behaviour.
 *
 * The C++ `src/core/DependencyGraph.cpp` was ported first; the cycle guard and edge
 * deduplication were added on 2026-10-15 because FunctionCard will let cards depend on
 * cards, which makes loops reachable. That C++ source no longer exists in this repo —
 * see docs/decisions/2026-10-15-qt-implementation-removed.md.
 */
import { describe, expect, it } from 'vitest';

import { DependencyGraph } from '../src/core/DependencyGraph.ts';

describe('DependencyGraph', () => {
  it('tracks dependents of a node', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1); // chart 10 depends on matrix 1
    graph.addDependency(11, 1);

    expect(graph.getDependents(1).sort()).toEqual([10, 11]);
    expect(graph.hasDependents(1)).toBe(true);
    expect(graph.getDependents(99)).toEqual([]);
    expect(graph.hasDependents(99)).toBe(false);
  });

  it('removes a node both as target and as dependent', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    graph.addDependency(11, 10); // 11 depends on 10

    graph.removeAllDependencies(10);

    // 10 is no longer a target...
    expect(graph.hasDependents(10)).toBe(false);
    // ...and no longer appears in someone else's dependent list.
    expect(graph.getDependents(1)).toEqual([]);
  });

  it('keeps unrelated edges when removing', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    graph.addDependency(11, 2);
    graph.addDependency(12, 1);

    graph.removeAllDependencies(10);

    expect(graph.getDependents(1)).toEqual([12]);
    expect(graph.getDependents(2)).toEqual([11]);
  });

  it('returns a defensive copy of the dependent list', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    const list = graph.getDependents(1);
    list.push(999);
    expect(graph.getDependents(1)).toEqual([10]);
  });

  it('clears everything', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    graph.clear();
    expect(graph.getDependents(1)).toEqual([]);
    expect(graph.edges()).toEqual([]);
  });

  it('exposes its edges for inspection', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    expect(graph.edges()).toEqual([{ dependsOn: 1, dependent: 10, ports: [] }]);
  });

  // ── port identity on edges (2026-10-28) ─────────────────────────────

  it('keeps one edge per card pair and collects its port ids', () => {
    const graph = new DependencyGraph();
    // A chart reading two columns of one table is still one line (2026-10-24), but both
    // port ids must survive: the connection layer anchors on portId, never on position
    // (port-semantics-v1 §已锁定 1).
    graph.addDependency(10, 1, 'src:7:2');
    graph.addDependency(10, 1, 'src:7:0');

    expect(graph.edgeCount()).toBe(1);
    expect(graph.getPorts(10, 1)).toEqual(['src:7:0', 'src:7:2']);
    expect(graph.edges()).toEqual([
      { dependsOn: 1, dependent: 10, ports: ['src:7:0', 'src:7:2'] },
    ]);
  });

  it('removes one port and keeps the edge while another port still names it', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1, ['src:7:0', 'src:7:2']);

    graph.removeDependency(10, 1, 'src:7:0');
    expect(graph.hasDependents(1)).toBe(true);
    expect(graph.getPorts(10, 1)).toEqual(['src:7:2']);

    graph.removeDependency(10, 1, 'src:7:2');
    expect(graph.hasDependents(1)).toBe(false);
  });

  it('records no ports when a refused edge would close a loop', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1, 'src:7:0');
    const cycle = graph.addDependency(1, 10, 'out');

    expect(cycle).not.toBeNull();
    expect(graph.getPorts(1, 10)).toEqual([]);
    expect(graph.edgeCount()).toBe(1);
  });

  // ── edge deduplication (2026-10-15) ───────────────────────────────────

  it('does not register the same edge twice', () => {
    const graph = new DependencyGraph();
    expect(graph.addDependency(10, 1)).toBeNull();
    expect(graph.addDependency(10, 1)).toBeNull(); // idempotent, not an error

    expect(graph.getDependents(1)).toEqual([10]);
    expect(graph.edgeCount()).toBe(1);
  });

  it('reports one refresh target per duplicate registration', () => {
    // Regression: a duplicated edge made getDependents return the chart twice, so
    // "switch file -> refresh charts" rebuilt the same card on every pass.
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    graph.addDependency(10, 1);
    expect(graph.getDependents(1).length).toBe(1);
  });

  // ── cycle prevention (2026-10-15) ─────────────────────────────────────

  it('refuses a self-dependency and reports the loop', () => {
    const graph = new DependencyGraph();
    const cycle = graph.addDependency(5, 5);

    expect(cycle).not.toBeNull();
    expect(cycle).toEqual([5, 5]);
    expect(graph.hasDependents(5)).toBe(false); // nothing was mutated
  });

  it('refuses an edge that closes a two-node loop', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1); // chart 10 depends on matrix 1

    const cycle = graph.addDependency(1, 10); // matrix 1 depending on its own chart

    // The ring is reported from the node that would start the loop.
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual([10, 1, 10]);
    expect(graph.edgeCount()).toBe(1);
    expect(graph.hasCycle()).toBe(false);
  });

  it('refuses an edge that closes a longer loop', () => {
    const graph = new DependencyGraph();
    graph.addDependency(2, 1);
    graph.addDependency(3, 2);
    graph.addDependency(4, 3);

    const cycle = graph.addDependency(1, 4);

    expect(cycle).not.toBeNull();
    expect(cycle).toEqual([4, 3, 2, 1, 4]);
    expect(graph.edgeCount()).toBe(3);
  });

  it('allows a diamond — shared upstream is not a cycle', () => {
    const graph = new DependencyGraph();
    graph.addDependency(3, 1);
    graph.addDependency(3, 2);
    graph.addDependency(4, 1);
    graph.addDependency(4, 2);

    expect(graph.hasCycle()).toBe(false);
    expect(graph.getDependencies(3).sort()).toEqual([1, 2]);
    expect(graph.getDependents(1).sort()).toEqual([3, 4]);
  });

  it('finds a path between nodes and returns null when unreachable', () => {
    const graph = new DependencyGraph();
    graph.addDependency(2, 1);
    graph.addDependency(3, 2);

    expect(graph.findPath(1, 3)).toEqual([1, 2, 3]);
    expect(graph.findPath(3, 1)).toBeNull();
    expect(graph.findPath(1, 99)).toBeNull();
  });

  // ── removeDependency (card-level connection lines) ──────────────────

  it('removes an existing edge and every query agrees afterwards', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1); // chart 10 depends on matrix 1
    graph.addDependency(11, 1);

    graph.removeDependency(10, 1);

    expect(graph.edgeCount()).toBe(1);
    expect(graph.hasDependents(1)).toBe(true);
    expect(graph.getDependents(1)).toEqual([11]);
    expect(graph.edges()).toEqual([{ dependsOn: 1, dependent: 11, ports: [] }]);
  });

  it('is a no-op for an edge that does not exist', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    const before = graph.edges();

    expect(() => graph.removeDependency(99, 1)).not.toThrow();
    expect(() => graph.removeDependency(10, 99)).not.toThrow();
    expect(graph.edgeCount()).toBe(1);
    expect(graph.edges()).toEqual(before);
  });

  it('drops the map key when the last dependent is removed, leaving other edges alone', () => {
    const graph = new DependencyGraph();
    graph.addDependency(10, 1);
    graph.addDependency(11, 2);
    graph.addDependency(12, 1);

    graph.removeDependency(12, 1);
    expect(graph.hasDependents(1)).toBe(true); // 10 still depends on 1

    graph.removeDependency(10, 1);
    expect(graph.hasDependents(1)).toBe(false); // the key itself is dropped
    expect(graph.edgeCount()).toBe(1);
    expect(graph.edges()).toEqual([{ dependsOn: 2, dependent: 11, ports: [] }]);
  });
});
