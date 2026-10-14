/**
 * DependencyGraph parity with `src/core/DependencyGraph.cpp`.
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
    expect(graph.edges()).toEqual([{ dependsOn: 1, dependent: 10 }]);
  });
});
