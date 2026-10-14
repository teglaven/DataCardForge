/**
 * @vitest-environment jsdom
 *
 * Connection-anchor invalidation on table scroll (fix A, 2026-10-15).
 *
 * `cardMetrics.headerAnchor()` reads `viewport.scrollLeft` live, so scrolling a matrix
 * table moves the anchor of every column — and can push a column out of the viewport,
 * which is exactly when the connection line must snap to an edge. That only reaches the
 * SVG layer if something bumps the layout version. Drag and resize did; plain scrolling
 * did not, so lines drifted off their headers and stayed stale until the next drag.
 *
 * These tests mount the real VirtualTable in jsdom and assert the counter moves.
 */
import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getLayoutVersion,
  headerAnchor,
  registerCard,
  setTableMetrics,
  unregisterCard,
} from '../src/ui/cardMetrics.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { VirtualTable, type VirtualTableProps } from '../src/ui/components/VirtualTable.tsx';

// React 19 wants this set so act() works outside its test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

/** Mount and flush effects — createRoot().render() is concurrent, so this must be awaited. */
async function mount(props: VirtualTableProps): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <VirtualTable {...props} />
      </StrictMode>,
    );
  });
  // Passive effects (the ResizeObserver that publishes table metrics) run in a later
  // task than the synchronous commit, so give them a turn before touching the DOM.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

function buildMatrix(columns: number): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, [1, 2, 3, 4, 5]);
    mat.setColumnAnnotation(c, `sensor ${c}`);
  }
  return mat;
}

/** jsdom always reports 0 for scroll offsets, so give the element real values. */
function stubScroll(element: HTMLElement): (left: number, top: number) => void {
  let left = 0;
  let top = 0;
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = value;
    },
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return (nextLeft, nextTop) => {
    left = nextLeft;
    top = nextTop;
  };
}

/** jsdom returns all-zero rects; both helpers below hand elements real geometry. */
function stubRect(element: HTMLElement, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function publishedTable(cardId: number) {
  const root = document.createElement('div');
  const viewport = document.createElement('div');
  document.body.appendChild(root);
  root.appendChild(viewport);
  stubRect(root, 0, 0, 800, 600);
  stubRect(viewport, 10, 40, 700, 400);

  registerCard(cardId, root);
  setTableMetrics(cardId, {
    tableViewport: viewport,
    columnOffsets: [64, 182, 300],
    columnWidths: [118, 118, 118],
    headerHeight: 26,
  });
  const scrollTo = stubScroll(viewport);

  return {
    scrollTo,
    cleanup() {
      unregisterCard(cardId);
      document.body.removeChild(root);
    },
  };
}

describe('VirtualTable scroll invalidates connection anchors', () => {
  it('bumps the layout version when the body scrolls horizontally', async () => {
    const host = await mount({
      matrix: buildMatrix(8),
      readOnly: true,
      rowLabel: (n) => `No.${n}`,
    });

    const viewport = host.querySelector<HTMLElement>('.vtable__viewport');
    expect(viewport).not.toBeNull();
    const scrollTo = stubScroll(viewport!);

    const before = getLayoutVersion();
    await act(async () => {
      scrollTo(240, 0);
      viewport!.dispatchEvent(new Event('scroll'));
    });

    expect(getLayoutVersion()).toBeGreaterThan(before);
  });

  it('bumps the layout version on vertical scroll too', async () => {
    const host = await mount({
      matrix: buildMatrix(3),
      readOnly: true,
      rowLabel: (n) => `No.${n}`,
    });

    const viewport = host.querySelector<HTMLElement>('.vtable__viewport');
    expect(viewport).not.toBeNull();
    const scrollTo = stubScroll(viewport!);

    const before = getLayoutVersion();
    await act(async () => {
      scrollTo(0, 1_000);
      viewport!.dispatchEvent(new Event('scroll'));
    });

    expect(getLayoutVersion()).toBeGreaterThan(before);
  });

  it('headerAnchor follows the live scrollLeft of the published viewport', () => {
    // The anchor is computed from the DOM at read time, so a moved scrollLeft must move
    // the reported x one-for-one — that is what keeps the line glued to its header.
    const table = publishedTable(900);
    try {
      const atZero = headerAnchor(900, 1);
      table.scrollTo(200, 0);
      const atScroll = headerAnchor(900, 1);

      expect(atZero).not.toBeNull();
      expect(atScroll).not.toBeNull();
      expect(atZero!.visible).toBe(true);
      expect(atScroll!.x).toBeCloseTo(atZero!.x - 200, 6);
    } finally {
      table.cleanup();
    }
  });

  it('clamps the anchor to the viewport edge once the column scrolls out', () => {
    const table = publishedTable(901);
    try {
      // Column 2 sits at 300..418 inside a 700px-wide viewport -> visible.
      expect(headerAnchor(901, 2)!.visible).toBe(true);

      // Scroll past it entirely: localLeft = 300 - 600 = -300, so it is off to the left.
      table.scrollTo(600, 0);
      const clamped = headerAnchor(901, 2)!;
      expect(clamped.visible).toBe(false);
      expect(clamped.offLeft).toBe(true);
      // Pinned to the viewport's left edge instead of following into negative space.
      expect(clamped.x).toBeCloseTo(10, 6);
    } finally {
      table.cleanup();
    }
  });
});
