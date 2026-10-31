/**
 * @vitest-environment jsdom
 *
 * Summary panel (摘要) — the four visible states, the one-node lifecycle and the CSV text.
 *
 * The suite runs against the REAL store and a stubbed transport, because the point of the
 * panel is not how it draws a table but what it is allowed to believe:
 *
 *   - 未请求 prints no number at all (the panel never computes on its own);
 *   - 计算 creates exactly ONE node per card, and 重算 reuses it (a second node would be
 *     orphaned server-side, with a result matrix nobody releases);
 *   - 有结果 prints the backend's numbers, in catalog order, with the raw catalog ids as row
 *     labels — the values here are deliberately NOT the statistics of the source table, so
 *     a client-side implementation cannot pass;
 *   - 待重算 (dirty + upstreamChanged) shows the banner and NO table — the backend emptied
 *     the result matrix, so a `0` here would be invented.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import {
  SUMMARY_STATS,
  canonicalSummaryStats,
  useWorkspace,
  type SummaryResultTable,
} from '../src/ui/workspaceStore.ts';
import type { MatrixCardModel } from '../src/ui/types.ts';
import type { NodeEvent } from '../src/backend/client.ts';
import { SummaryPanel, summaryCsv } from '../src/ui/components/SummaryPanel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

/**
 * The numbers the "backend" answers with.
 *
 * Deliberately unrelated to the source column (1, 2, 3, 4): if any of them ever showed up
 * on screen, the panel would be computing locally, which the B-plan forbids.
 */
const COL_A = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
const COL_B = [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212];

function matrix(columns: number): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, [1, 2, 3, 4]);
    mat.setColumnAnnotation(c, c === 0 ? 'A' : 'B');
  }
  return mat;
}

/** DCM2 dense frame: 12 statistics rows × the given columns (column-major). */
function encodeFrame(columns: number[][], names: string[]): ArrayBuffer {
  const rows = 12;
  const cols = columns.length;
  const namesBytes = new TextEncoder().encode(JSON.stringify(names));
  const buffer = new ArrayBuffer(24 + cols * rows * 8 + namesBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x44434d32, true); // DCM2
  view.setUint32(4, rows, true);
  view.setUint32(8, cols, true);
  view.setUint32(12, namesBytes.length, true);
  view.setUint32(16, rows, true);
  view.setUint32(20, cols, true);
  let offset = 24;
  for (const column of columns) {
    for (let r = 0; r < rows; ++r) view.setFloat64(offset + r * 8, column[r] ?? NaN, true);
    offset += rows * 8;
  }
  new Uint8Array(buffer, offset, namesBytes.length).set(namesBytes);
  return buffer;
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

/**
 * Stub the transport the panel talks to: matrix upload, node create, the explicit compute,
 * the node status read and the result-matrix window. `state` is what `POST /compute`
 * answers, so one stub serves the done and the error suites.
 */
function stubBackend(opts: { computeError?: string } = {}) {
  const calls: Call[] = [];
  let nextNodeId = 1;
  let nextMatrixId = 100;
  /** The result matrix each node owns. */
  const resultOf = new Map<number, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });

    if (url.endsWith('/api/matrices') && method === 'POST') {
      return json({ matrixId: nextMatrixId++, revision: 1 });
    }
    if (url.endsWith('/api/nodes') && method === 'POST') {
      const nodeId = nextNodeId++;
      const resultMatrixId = nextMatrixId++;
      resultOf.set(nodeId, resultMatrixId);
      return json({
        nodeId,
        resultMatrixId,
        resultMatrixIds: [resultMatrixId],
        signatureId: 'builtin:summary',
        // A lazy signature is born uncomputed (decision §四).
        state: 'dirty',
        reason: 'notRequested',
      });
    }
    const compute = /\/api\/nodes\/(\d+)\/compute$/.exec(url);
    if (compute && method === 'POST') {
      const nodeId = Number(compute[1]);
      if (opts.computeError) {
        const text = JSON.stringify({ code: opts.computeError });
        return {
          ok: false,
          status: 400,
          text: async () => text,
          json: async () => ({ code: opts.computeError }),
        } as unknown as Response;
      }
      return json({ nodeId, state: 'done', resultMatrixIds: [resultOf.get(nodeId)] });
    }
    const nodePath = /\/api\/nodes\/(\d+)$/.exec(url);
    if (nodePath && method === 'GET') {
      const nodeId = Number(nodePath[1]);
      return json({ nodeId, state: 'done', resultMatrixId: resultOf.get(nodeId) });
    }
    if (nodePath && method === 'PATCH') {
      // The real server answers nodeId + state only (http_server.cpp): no output ids, and a
      // parameter edit always lands on `dirty`.
      return json({ nodeId: Number(nodePath[1]), state: 'dirty' });
    }
    if (url.includes('/window')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => encodeFrame([COL_A, COL_B], ['Pos.1 A', 'Pos.2 B']),
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

/** Wait for the compute chain (create → compute → status → window) to settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(card: MatrixCardModel): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<SummaryPanel card={card} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

/** A data card with one uploaded table, as the store would hold it. */
async function setupCard(): Promise<MatrixCardModel> {
  const cardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix(2) }]);
  // Registration is fire-and-forget; the panel's compute awaits it, but waiting here keeps
  // the assertions about request COUNT unambiguous.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return store().cards.find((card) => card.id === cardId) as MatrixCardModel;
}

function expand(host: HTMLElement): void {
  const toggle = host.querySelector<HTMLButtonElement>('.summary-panel__toggle');
  expect(toggle).not.toBeNull();
  act(() => toggle!.click());
}

function panelText(host: HTMLElement): string {
  return host.querySelector('.summary-panel')?.textContent ?? '';
}

function rowLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.summary-panel__row .summary-panel__stat')].map(
    (cell) => cell.textContent ?? '',
  );
}

let backend: ReturnType<typeof stubBackend> | null = null;

beforeEach(async () => {
  store().reset();
  store().setLocale('zh');
  backend = stubBackend();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  backend?.restore();
  backend = null;
});

describe('summary panel — 未请求', () => {
  it('offers 计算 and prints no number at all', async () => {
    const card = await setupCard();
    const host = await mount(card);
    expand(host);

    expect(host.querySelector('.summary-panel__bar--notRequested')).not.toBeNull();
    const button = host.querySelector<HTMLButtonElement>('.summary-panel__compute');
    expect(button?.textContent).toBe('计算');
    // "Nothing has been asked for" must not look like a result: a digit anywhere here would
    // be a fabricated number (a table, a count, a timestamp).
    expect(panelText(host)).not.toMatch(/\d/);
    expect(host.querySelectorAll('.summary-panel__row')).toHaveLength(0);
    // And nothing has been created yet: the node is lazy (lifecycle plan A).
    expect(
      backend!.calls.filter((call) => call.method === 'POST' && /\/api\/nodes$/.test(call.url)),
    ).toHaveLength(0);
  });
});

describe('summary panel — 计算 lifecycle', () => {
  it('creates ONE node and reuses it on 重算', async () => {
    const card = await setupCard();
    const host = await mount(card);
    expand(host);

    const creates = () =>
      backend!.calls.filter((call) => call.method === 'POST' && /\/api\/nodes$/.test(call.url));
    const computes = () =>
      backend!.calls.filter((call) => call.method === 'POST' && /\/compute$/.test(call.url));

    act(() => host.querySelector<HTMLButtonElement>('.summary-panel__compute')!.click());
    await settle();
    expect(creates()).toHaveLength(1);
    expect(computes()).toHaveLength(1);
    // The parameters travel with creation: the catalogue filter, canonical and non-empty.
    expect(JSON.parse(creates()[0].body!)).toMatchObject({
      signatureId: 'builtin:summary',
      params: { stats: [...SUMMARY_STATS] },
    });

    // 重算 is the SAME node: a second create would leak a node + its result matrix.
    const recompute = host.querySelector<HTMLButtonElement>('.summary-panel__compute');
    expect(recompute?.textContent).toBe('重算');
    act(() => recompute!.click());
    await settle();
    expect(creates()).toHaveLength(1);
    expect(computes()).toHaveLength(2);
  });
});

describe('summary panel — 有结果', () => {
  it('renders 12 rows in catalog order with the backend values', async () => {
    const card = await setupCard();
    const host = await mount(card);
    expand(host);
    act(() => host.querySelector<HTMLButtonElement>('.summary-panel__compute')!.click());
    await settle();

    expect(host.querySelector('.summary-panel__bar--done')).not.toBeNull();
    // Row identity is the raw catalog id, in catalog order — never translated.
    expect(rowLabels(host)).toEqual([...SUMMARY_STATS]);
    expect(host.querySelectorAll('.summary-panel__row')).toHaveLength(12);

    const headers = [...host.querySelectorAll('.summary-panel__table thead th')].map(
      (cell) => cell.textContent,
    );
    // Columns inherit the source column labels verbatim (decision §三).
    expect(headers).toEqual(['统计量', 'Pos.1 A', 'Pos.2 B']);

    const firstRow = [...host.querySelectorAll('.summary-panel__row')[0].querySelectorAll('.summary-panel__cell')].map(
      (cell) => cell.textContent,
    );
    // The numbers are the stub's, not `mean(1,2,3,4) = 2.5`: no local arithmetic exists.
    expect(firstRow).toEqual(['101', '201']);
    const lastRow = [...host.querySelectorAll('.summary-panel__row')[11].querySelectorAll('.summary-panel__cell')].map(
      (cell) => cell.textContent,
    );
    expect(lastRow).toEqual(['112', '212']);
    // The computed-at stamp is labelled as LOCAL time (there is no protocol field).
    expect(panelText(host)).toMatch(/计算于 .*（本地时间）/);
  });
});

describe('summary panel — 待重算', () => {
  it('shows the stale banner and an EMPTY table (never a row of zeros)', async () => {
    const card = await setupCard();
    const host = await mount(card);
    expand(host);
    act(() => host.querySelector<HTMLButtonElement>('.summary-panel__compute')!.click());
    await settle();
    const nodeId = store().summaries[card.id].nodeId!;

    // The backend's own push: a matrix edit upstream marks the node dirty with a reason
    // (and it has already emptied the result matrix).
    await act(async () => {
      store().applyNodeEvent({
        seq: 1,
        nodeId,
        state: 'dirty',
        reason: 'upstreamChanged',
      } as NodeEvent & { reason: 'upstreamChanged' });
    });

    expect(host.querySelector('.summary-panel__bar--stale')).not.toBeNull();
    expect(panelText(host)).toContain('上游已变');
    expect(host.querySelectorAll('.summary-panel__row')).toHaveLength(0);
    expect(host.querySelectorAll('.summary-panel__cell')).toHaveLength(0);
    // No table at all — so not a single value, and in particular no row of zeros. (The
    // statistic filter's labels are catalog ids and may legitimately contain digits: `q1`.)
    expect(host.querySelector('.summary-panel__table')).toBeNull();
    expect(panelText(host)).not.toContain('101');
    expect(panelText(host)).not.toContain('0 ');
    expect(host.querySelector<HTMLButtonElement>('.summary-panel__compute')).not.toBeNull();
  });

  it('says 参数已改 when the statistic filter changes', async () => {
    const card = await setupCard();
    const host = await mount(card);
    expand(host);
    act(() => host.querySelector<HTMLButtonElement>('.summary-panel__compute')!.click());
    await settle();

    // Uncheck "sem": the filter is a definition change, so the node is PATCHed and the
    // panel has to admit its numbers no longer match the parameters.
    const sem = [...host.querySelectorAll<HTMLInputElement>('.summary-panel__stat-option input')].at(-1)!;
    await act(async () => {
      sem.click();
    });
    await settle();
    expect(panelText(host)).toContain('参数已改');
    expect(host.querySelectorAll('.summary-panel__row')).toHaveLength(0);
    expect(store().summaries[card.id].stats).not.toContain('sem');
  });
});

describe('summary panel — 错误', () => {
  it('renders the same error style the function card uses', async () => {
    backend?.restore();
    backend = stubBackend({ computeError: 'badSignatureParams' });
    const card = await setupCard();
    const host = await mount(card);
    expand(host);
    act(() => host.querySelector<HTMLButtonElement>('.summary-panel__compute')!.click());
    await settle();

    const alert = host.querySelector('.summary-panel__error');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    // The structured code travels; the sentence is i18n's, and the panel has no `params`
    // channel to fill a placeholder in, so it degrades to the generic sentence + the code.
    expect(alert?.textContent).toContain('badSignatureParams');
    expect(host.querySelectorAll('.summary-panel__row')).toHaveLength(0);
    // Retry stays possible: an error is not a dead end.
    expect(host.querySelector<HTMLButtonElement>('.summary-panel__compute')).not.toBeNull();
  });
});

describe('summary params', () => {
  it('canonicalises the statistic filter: unknown ids dropped, catalog order kept', () => {
    // `params.stats` is a FILTER, never a reordering (decision §一): the row identity is the
    // catalog position, so a reversed request must come back in catalog order.
    expect(canonicalSummaryStats(['sem', 'n', 'mean'])).toEqual(['n', 'mean', 'sem']);
    expect(canonicalSummaryStats(['n', 'nope'])).toEqual(['n']);
    // The backend answers `stats: []` with badSignatureParams, so the panel never sends an
    // empty filter — an all-unknown request degrades to the whole catalog instead.
    expect(canonicalSummaryStats([])).toEqual([...SUMMARY_STATS]);
    expect(canonicalSummaryStats(['nope'])).toEqual([...SUMMARY_STATS]);
  });
});

describe('summary CSV', () => {
  it('writes the column labels, then one row per statistic in order', () => {
    const result: SummaryResultTable = {
      columns: ['Pos.1 A', 'Pos.2 B'],
      stats: [...SUMMARY_STATS],
      rows: SUMMARY_STATS.map((_, row) => [COL_A[row], COL_B[row]]),
    };
    const lines = summaryCsv(result).replace(/^\ufeff/, '').split('\n');
    expect(lines).toHaveLength(13); // header + 12 statistics
    expect(lines[0]).toBe('Pos.1 A,Pos.2 B');
    expect(lines[1]).toBe('n,101,201');
    expect(lines[12]).toBe('sem,112,212');
    // Row order == catalog order, and the first cell is the raw id.
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([...SUMMARY_STATS]);
  });
});
