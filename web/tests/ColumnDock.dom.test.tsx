/**
 * @vitest-environment jsdom
 *
 * Column dock — the collapsible column picker on the left of a chart card.
 *
 * The dock is exercised against the real store: it lists the matrix card's active
 * file, checks what the chart already plots, and writes choices back through
 * addChartSource / removeChartSource (which also manage the card-level dependency).
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { ChartCardModel } from '../src/ui/types.ts';
import { ColumnDock } from '../src/ui/components/ColumnDock.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

function matrix(columns: number): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, [1, 2, 3, 4, 5]);
    mat.setColumnAnnotation(c, `sensor ${c}`);
  }
  return mat;
}

async function mount(
  card: ChartCardModel,
  open: boolean,
  onToggle: (next: boolean) => void = () => {},
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <ColumnDock card={card} open={open} onToggle={onToggle} />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

function chartOf(id: number): ChartCardModel {
  return store().cards.find((card) => card.id === id) as ChartCardModel;
}

/** A 4-column table plus a line chart attached to its first column. */
function setupScene(): { matrixId: number; chartId: number } {
  const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix(4) }]);
  const chartId = store().addChartCard(matrixCardId, 0)!;
  const matrixId = (store().cards.find((c) => c.id === matrixCardId) as {
    sources: { matrixId: number }[];
  }).sources[0].matrixId;
  return { matrixId, chartId };
}

beforeEach(() => {
  store().reset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('collapsed rail', () => {
  it('shows only a vertical toggle and asks to open when clicked', async () => {
    const { chartId } = setupScene();
    const onToggle = vi.fn();
    const host = await mount(chartOf(chartId), false, onToggle);

    const toggle = host.querySelector<HTMLButtonElement>('.chart-card__dock-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.chart-card__dock--open')).toBeNull();

    await act(async () => {
      toggle!.click();
    });
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe('expanded picker', () => {
  it('lists every column of the active file, grouped by file name', async () => {
    const { chartId } = setupScene();
    const host = await mount(chartOf(chartId), true);

    expect(host.querySelector('.chart-card__dock--open')).not.toBeNull();
    expect(host.querySelector('.chart-card__dock-list')).not.toBeNull();
    expect(host.querySelector('.chart-card__dock-group-title')!.textContent).toBe('a.csv');

    const items = host.querySelectorAll('.chart-card__dock-item');
    expect(items).toHaveLength(4);
    const labels = [...items].map((item) => item.querySelector('.chart-card__dock-item-label')!.textContent);
    expect(labels).toEqual(['Pos.1 sensor 0', 'Pos.2 sensor 1', 'Pos.3 sensor 2', 'Pos.4 sensor 3']);

    // The chart's existing column is checked and carries its 1-based order badge.
    const first = items[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(first.checked).toBe(true);
    expect(items[0].querySelector('.chart-card__dock-badge')!.textContent).toBe('1');
  });

  it('checks and unchecks a column through the store', async () => {
    const { chartId } = setupScene();
    let host = await mount(chartOf(chartId), true);

    let boxes = host.querySelectorAll<HTMLInputElement>('.chart-card__dock-item input[type="checkbox"]');
    await act(async () => {
      boxes[1].click();
    });
    expect(chartOf(chartId).config.sources).toHaveLength(2);

    // The parent re-renders with the fresh card; remounting stands in for that.
    host = await mount(chartOf(chartId), true);
    boxes = host.querySelectorAll<HTMLInputElement>('.chart-card__dock-item input[type="checkbox"]');
    expect(boxes[1].checked).toBe(true);

    await act(async () => {
      boxes[1].click();
    });
    expect(chartOf(chartId).config.sources).toHaveLength(1);
  });

  it('refuses to uncheck the last plotted column (the chart floor)', async () => {
    const { chartId } = setupScene();
    const host = await mount(chartOf(chartId), true);

    const first = host.querySelectorAll<HTMLInputElement>(
      '.chart-card__dock-item input[type="checkbox"]',
    )[0];
    expect(first.checked).toBe(true);
    expect(first.disabled).toBe(true);
    expect(first.title).toMatch(/at least 1|至少需要 1/);
  });

  it('marks the X-axis column with an X badge', async () => {
    const { matrixId, chartId } = setupScene();
    store().setChartConfig(chartId, {
      xAxisSource: { matrixId, columnIndex: 1, label: 'Pos.2 sensor 1', raw: [1, 2, 3, 4, 5] },
    });

    const host = await mount(chartOf(chartId), true);
    const badges = [...host.querySelectorAll('.chart-card__dock-badge')].map(
      (badge) => badge.textContent,
    );
    expect(badges).toContain('X');

    const items = host.querySelectorAll('.chart-card__dock-item');
    const secondBadges = [...items[1].querySelectorAll('.chart-card__dock-badge')].map(
      (badge) => badge.textContent,
    );
    expect(secondBadges).toContain('X');
  });

  it('shows the pairing hint for paired chart types only', async () => {
    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix(4) }]);
    const lineChart = store().addChartCard(matrixCardId, 0)!;
    const scatterChart = store().addChartCard(matrixCardId, 0, 'scatter')!;

    let host = await mount(chartOf(lineChart), true);
    expect(host.querySelector('.chart-card__dock-order')).toBeNull();

    host = await mount(chartOf(scatterChart), true);
    expect(host.querySelector('.chart-card__dock-order')).not.toBeNull();
  });

  it('shows the empty state when no table is open', async () => {
    const { chartId } = setupScene();
    const detached = chartOf(chartId);
    store().reset();

    const host = await mount(detached, true);
    expect(host.querySelector('.chart-card__dock-empty')).not.toBeNull();
    expect(host.querySelectorAll('.chart-card__dock-item')).toHaveLength(0);
  });
});
