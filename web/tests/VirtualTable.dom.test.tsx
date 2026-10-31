/**
 * @vitest-environment jsdom
 *
 * Horizontal scroll alignment (the "header and cells drift apart" bug).
 *
 * The header row lives OUTSIDE `.vtable__viewport`, so it cannot scroll natively and is
 * moved by a `translateX(-scrollLeft)` from the scroll handler. The body rows are inside the
 * scroller and MUST NOT be translated: doing both moved the cells twice as far as the
 * header, so dragging the table right put every number under the wrong column name — and it
 * only became visible once the columns overflowed the card (short tables never scroll).
 *
 * jsdom has no layout (every rect is zero, `scrollLeft` never moves the paint), so this
 * test drives `scrollLeft` and asserts the two styles that encode the rule: the header
 * translates by exactly the scroll amount, and no row translates at all.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { VirtualTable } from '../src/ui/components/VirtualTable.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

function table(columns = 6, rows = 4): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, Array.from({ length: rows }, (_, r) => r + c));
  }
  return mat;
}

async function mount(matrix: MatrixData, columnLabel?: (n: number) => string | null) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <VirtualTable
          matrix={matrix}
          readOnly
          rowLabel={(n) => `No.${n}`}
          columnLabel={columnLabel}
        />
      </StrictMode>,
    );
  });
  return host;
}

function scrollTo(viewport: HTMLElement, left: number): void {
  viewport.scrollLeft = left;
  viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('virtual table horizontal scroll', () => {
  it('moves the header by the scroll amount and leaves the rows to native scrolling', async () => {
    const host = await mount(table());
    const viewport = host.querySelector<HTMLElement>('.vtable__viewport')!;
    const header = host.querySelector<HTMLElement>('.vtable__header-inner')!;
    const row = host.querySelector<HTMLElement>('.vtable__row')!;

    expect(header.style.transform).toContain('0px');
    expect(row.style.transform).toBe('');

    await act(async () => {
      scrollTo(viewport, 120);
    });

    // Exactly once: the header follows the scrollbar…
    expect(header.style.transform).toBe('translateX(-120px)');
    // …while the body is already moved by the scroller itself. A translate here was the bug.
    expect(host.querySelector<HTMLElement>('.vtable__row')!.style.transform).toBe('');

    await act(async () => {
      scrollTo(viewport, 0);
    });
    expect(header.style.transform).toBe('translateX(-0px)');
  });

  it('prints a card-provided header override but keeps the stored label in the title', async () => {
    const host = await mount(table(2), (index) => `X : Y · ${index}`);

    const headers = [...host.querySelectorAll<HTMLElement>('.vtable__colhead')];
    expect(headers.map((entry) => entry.textContent)).toEqual(['X : Y · 0', 'X : Y · 1']);
    // The override is presentation only; hovering still reveals the data's own label.
    expect(headers[0].title).toBe('X : Y · 0');
  });
});
