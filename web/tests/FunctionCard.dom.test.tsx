/**
 * @vitest-environment jsdom
 *
 * Function card, three-zone layout (README 函数卡 UI).
 *
 * These assertions lock the structure the function-card review settled on, because each
 * zone carries a decision rather than decoration:
 *   - the **input** zone names the explicit matrix the card reads (the thing that used to
 *     be implicit and silently changed when a table switched files);
 *   - the **formula** zone is the parameter bag (one row per expression);
 *   - the **output** zone lists the signature's declared outputs and the result grid;
 *   - an `upstreamError` is shown as *invalidated* (grey) rather than as this card's own
 *     definition error (red), and it still says something — never a silent blank.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';
import { FormulaCard, type ResolvedInput } from '../src/ui/components/FormulaCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

function matrix(columns: number, rows = 4): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, Array.from({ length: rows }, (_, r) => r + c));
    mat.setColumnAnnotation(c, `sensor ${c}`);
  }
  return mat;
}

interface CardOptions {
  inputs?: ResolvedInput[];
  resultMatrix?: MatrixData;
  sourceColumnNames?: string[];
}

async function mount(card: FunctionCardModel, options: CardOptions = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <FormulaCard
          card={card}
          resultMatrix={options.resultMatrix}
          sourceColumnNames={options.sourceColumnNames ?? []}
          inputs={options.inputs ?? []}
          active
          closeBlocked={false}
          onClose={() => {}}
          onCloseBlocked={() => {}}
          onActivate={() => {}}
        />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

/** Create a real function card through the store (offline: no node is registered). */
function makeCard(overrides: Partial<FunctionCardModel> = {}): FunctionCardModel {
  const matrixCardId = store().addMatrixCard([{ name: 'b.csv', matrix: matrix(3) }]);
  const cardId = store().addFormulaCard(matrixCardId);
  expect(cardId).not.toBeNull();
  const card = store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
  return { ...card, ...overrides };
}

beforeEach(() => {
  store().reset();
  // jsdom's navigator.language is en-US, so pin the locale the assertions read.
  store().setLocale('zh');
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('function card zones', () => {
  it('renders the three zones', async () => {
    const host = await mount(makeCard(), {
      inputs: [
        { portId: 'src', mode: 'matrix', label: 'b.csv', rows: 4, cols: 3, missing: false },
      ],
    });
    expect(host.querySelector('.formula-card__inputs')).not.toBeNull();
    expect(host.querySelector('.formula-card__formulas')).not.toBeNull();
    expect(host.querySelector('.formula-card__outputs')).not.toBeNull();
    // The zone titles are real labels, not placeholder text.
    expect(host.querySelector('.formula-card__inputs')?.textContent).toContain('输入');
    expect(host.querySelector('.formula-card__formulas')?.textContent).toContain('计算公式');
    expect(host.querySelector('.formula-card__outputs')?.textContent).toContain('输出');
  });

  it('names the explicit matrix an input reads, with its shape', async () => {
    const host = await mount(makeCard(), {
      inputs: [
        { portId: 'src', mode: 'matrix', label: 'b.csv', rows: 4, cols: 3, missing: false },
      ],
    });
    const port = host.querySelector('.formula-card__port')!;
    expect(port.textContent).toContain('src');
    expect(port.textContent).toContain('b.csv');
    expect(port.textContent).toContain('4×3');
    // Matrix mode is stated, never inferred from colour.
    expect(port.querySelector('.formula-card__mode--matrix')?.textContent).toBe('矩阵');
  });

  it('shows a dangling reference as broken instead of silently reading nothing', async () => {
    const host = await mount(makeCard(), {
      inputs: [
        { portId: 'src', mode: 'matrix', label: '#99', rows: 0, cols: 0, missing: true },
      ],
    });
    const port = host.querySelector('.formula-card__port')!;
    expect(port.textContent).toContain('引用的矩阵已不存在');
    expect(port.querySelector('.formula-card__port-src--missing')).not.toBeNull();
  });

  it('explains the empty input zone instead of drawing an empty rail', async () => {
    const host = await mount(makeCard({ inputs: [] }), { inputs: [] });
    expect(host.querySelector('.formula-card__zone-empty')?.textContent).toContain('未连接数据源');
  });

  it('lists one formula row per expression (the parameter bag)', async () => {
    const card = makeCard({
      params: {
        formulas: [
          { name: 'double', expression: 'A * 2' },
          { name: 'sum', expression: 'A + B' },
        ],
      },
    });
    const host = await mount(card);
    const rows = host.querySelectorAll('.formula-card__row');
    expect(rows).toHaveLength(2);
    const names = [...host.querySelectorAll<HTMLInputElement>('.formula-card__name')].map(
      (input) => input.value,
    );
    expect(names).toEqual(['double', 'sum']);
    const exprs = [...host.querySelectorAll<HTMLInputElement>('.formula-card__expr')].map(
      (input) => input.value,
    );
    expect(exprs).toEqual(['A * 2', 'A + B']);
  });

  it('lists the declared outputs and the result shape', async () => {
    const host = await mount(makeCard(), {
      resultMatrix: matrix(2, 5),
    });
    const output = host.querySelector('.formula-card__output-item')!;
    expect(output.textContent).toContain('结果');
    expect(output.textContent).toContain('2 列 × 5 行');
    expect(host.querySelector('.formula-card__output-shape')?.textContent).toContain('2 列 × 5 行');
  });

  it('renders a structured error through i18n, never a bare code', async () => {
    const host = await mount(
      makeCard({ node: { nodeId: 4, state: 'error', code: 'unknownColumn', params: { name: 'ZZ' } } }),
    );
    const alert = host.querySelector('.formula-card__error')!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('未知列名');
    // The four-state light is red only for this card's OWN failure.
    expect(host.querySelector('.node-light--error')).not.toBeNull();
  });

  it('presents an upstream failure as invalidated (grey), not as its own error', async () => {
    const host = await mount(
      makeCard({
        node: { nodeId: 4, state: 'error', code: 'upstreamError', params: { name: 'n1' } },
      }),
    );
    // Grey/invalidated light instead of red…
    expect(host.querySelector('.node-light--stale')).not.toBeNull();
    expect(host.querySelector('.node-light--error')).toBeNull();
    // …and the reason is stated in words.
    expect(host.querySelector('.formula-card__stale')?.textContent).toContain('上游卡片失败');
  });

  it('falls back to a visible sentence + raw code for an unknown code', async () => {
    const host = await mount(
      makeCard({ node: { nodeId: 4, state: 'error', code: 'someBrandNewCode' } }),
    );
    const alert = host.querySelector('.formula-card__error')!;
    expect(alert.textContent).toContain('公式无法计算');
    expect(alert.textContent).toContain('someBrandNewCode');
  });
});
