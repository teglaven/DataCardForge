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
import { StrictMode, act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';
import { FormulaCard, type ResolvedInput } from '../src/ui/components/FormulaCard.tsx';
import type { RepointOffer } from '../src/ui/workspaceStore.ts';

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
  repoint?: RepointOffer | null;
  repointBatch?: number;
  onApplyRepoint?: () => void;
  onDismissRepoint?: () => void;
  onRenameOutputColumn?: (index: number, name: string) => void;
  onSetColumnContract?: (columns: number | null) => void;
  onOpenChart?: (columnIndex: number, type: string) => number | null;
  onOpenFunction?: () => void;
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
          repoint={options.repoint ?? null}
          repointBatch={options.repointBatch ?? 0}
          onApplyRepoint={options.onApplyRepoint ?? (() => {})}
          onDismissRepoint={options.onDismissRepoint ?? (() => {})}
          onApplyAllRepoints={() => {}}
          onRenameOutputColumn={options.onRenameOutputColumn ?? (() => {})}
          onSetColumnContract={options.onSetColumnContract ?? (() => {})}
          onOpenChart={options.onOpenChart ?? (() => null)}
          onOpenFunction={options.onOpenFunction ?? (() => {})}
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

describe('re-point banner', () => {
  const offer = (over: Partial<RepointOffer> = {}): RepointOffer => ({
    cardId: 1,
    ownerCardId: 2,
    fromMatrixId: 10,
    toMatrixId: 11,
    sameColumns: true,
    addedLabels: [],
    removedLabels: [],
    fromRows: 4,
    toRows: 6,
    rowDelta: 2,
    toCols: 3,
    toName: 'b.csv',
    ...over,
  });

  it('offers the switch in the output zone with a plain confirm when columns match', async () => {
    const host = await mount(makeCard(), { repoint: offer() });
    const banner = host.querySelector('.formula-card__repoint')!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('b.csv');
    expect(banner.textContent).toContain('列一致');
    const primary = banner.querySelector('.formula-card__repoint-primary')!;
    expect(primary.textContent).toBe('应用');
  });

  it('requires the "apply anyway" wording when the columns changed', async () => {
    const host = await mount(makeCard(), {
      repoint: offer({ sameColumns: false, addedLabels: ['Z'], removedLabels: ['A'] }),
    });
    const banner = host.querySelector('.formula-card__repoint')!;
    expect(banner.textContent).toContain('列已变化');
    expect(banner.textContent).toContain('+Z');
    expect(banner.textContent).toContain('−A');
    expect(banner.querySelector('.formula-card__repoint-primary')!.textContent).toContain(
      '仍然应用',
    );
  });

  it('shows the batch action only when more than one card would change', async () => {
    const single = await mount(makeCard(), { repoint: offer(), repointBatch: 1 });
    expect(single.textContent).not.toContain('应用到全部');
    const many = await mount(makeCard(), { repoint: offer(), repointBatch: 3 });
    expect(many.textContent).toContain('应用到全部 3 张');
  });

  it('wires apply / dismiss to the callbacks', async () => {
    let applied = 0;
    let dismissed = 0;
    const host = await mount(makeCard(), {
      repoint: offer(),
      onApplyRepoint: () => {
        applied += 1;
      },
      onDismissRepoint: () => {
        dismissed += 1;
      },
    });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.formula-card__repoint-actions button')];
    await act(async () => {
      buttons[0].click();
      buttons[1].click();
    });
    expect(applied).toBe(1);
    expect(dismissed).toBe(1);
  });
});

describe('output rename + column contract', () => {
  it('opens the rename editor from the output header and shows the lock hint bar', async () => {
    const host = await mount(makeCard());
    const toggle = host.querySelector<HTMLButtonElement>('.formula-card__rename')!;
    expect(toggle.textContent).toBe('重命名列');
    await act(async () => {
      toggle.click();
    });
    const inputs = host.querySelectorAll('.formula-card__rename-input');
    expect(inputs).toHaveLength(1);
    // The bottom bar states that naming locks the width — the promise is visible.
    const bar = host.querySelector('.formula-card__hintbar')!;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain('命名输出列后即锁定');
  });

  it('commits a rename on blur (the first commit creates the contract)', async () => {
    let renamed: { index: number; name: string } | null = null;
    const card = makeCard();
    const host = await mount(card, {
      onRenameOutputColumn: (index, name) => {
        renamed = { index, name };
      },
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.formula-card__rename')!.click();
    });
    const input = host.querySelector<HTMLInputElement>('.formula-card__rename-input')!;
    await act(async () => {
      input.focus();
      // React's onChange listens for `input`; the commit happens on blur (focusout).
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'temperature');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.blur();
    });
    expect(renamed).toEqual({ index: 0, name: 'temperature' });
  });

  it('states the locked width once a contract exists', async () => {
    const host = await mount(
      makeCard({
        params: {
          formulas: [{ name: 'a', expression: 'A * 2' }],
          columnContract: { outputId: 'result', columns: 1 },
        },
      }),
    );
    const bar = host.querySelector('.formula-card__hintbar')!;
    expect(bar.textContent).toContain('已锁定 1 列');
    expect(bar.textContent).toContain('中断数据流');
  });

  it('turns the hint bar into a stop notice on a contract violation, with both ways out', async () => {
    const c = makeCard({
      params: {
        formulas: [
          { name: 'a', expression: 'A * 2' },
          { name: 'b', expression: 'A + 1' },
        ],
        columnContract: { outputId: 'result', columns: 1 },
      },
      node: {
        nodeId: 9,
        state: 'error',
        code: 'columnContractViolation',
        params: { expected: 1, actual: 2 },
      },
    });
    let extended: number | null | undefined;
    const host = await mount(c, {
      onSetColumnContract: (columns) => {
        extended = columns;
      },
    });
    const bar = host.querySelector('.formula-card__hintbar')!;
    expect(bar.className).toContain('hintbar--violation');
    expect(bar.textContent).toContain('列数契约被破坏');
    expect(bar.textContent).toContain('锁定 1 列');
    expect(bar.textContent).toContain('实际 2 列');
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => b.textContent)).toEqual([
      '扩展契约到 2 列',
      '解除锁定',
    ]);
    await act(async () => {
      buttons[0].click();
    });
    expect(extended).toBe(2);
  });
});

describe('charting from the output table', () => {
  it('offers the chart picker on a result column header', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(2, 4) });
    const header = host.querySelector<HTMLElement>('.card--formula .vtable__colhead');
    expect(header).not.toBeNull();
    await act(async () => {
      header!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 160 }),
      );
    });
    const menu = document.querySelector('.context-menu--list');
    expect(menu).not.toBeNull();
    // Every declared chart type is offered, exactly like a data card's column header.
    expect(menu!.textContent).toContain('折线图');
    expect(menu!.textContent).toContain('相关性热力图');
  });

  it('creates the chart through onOpenChart with the clicked column', async () => {
    const calls: Array<{ column: number; type: string }> = [];
    const host = await mount(makeCard(), {
      resultMatrix: matrix(2, 4),
      onOpenChart: (column, type) => {
        calls.push({ column, type });
        return 42;
      },
    });
    const header = host.querySelector<HTMLElement>('.card--formula .vtable__colhead');
    await act(async () => {
      header!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 160 }),
      );
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')];
    await act(async () => {
      items[0].click();
    });
    expect(calls).toEqual([{ column: 0, type: 'line' }]);
  });
});

describe('chaining from the output menu', () => {
  it('offers "new function card" in the result header menu', async () => {
    let chained = 0;
    const host = await mount(makeCard(), {
      resultMatrix: matrix(1, 4),
      onOpenFunction: () => {
        chained += 1;
      },
    });
    await act(async () => {
      host
        .querySelector('.card--formula .vtable__colhead')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }));
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')];
    const chainedItem = items.find((item) => item.textContent?.includes('新建公式卡'));
    expect(chainedItem).toBeDefined();
    await act(async () => {
      chainedItem!.click();
    });
    expect(chained).toBe(1);
  });
});

describe('a signature without expressions', () => {
  const regressionCard = (): FunctionCardModel => ({
    ...makeCard(),
    signatureId: 'builtin:linear-regression',
    params: {},
    outputs: [{ outputId: 'fit', resultMatrixId: 7 }],
    inputs: [
      {
        portId: 'x',
        target: { type: 'cell', cardId: 1, matrixId: 10, column: 0 },
      },
      {
        portId: 'y',
        target: { type: 'cell', cardId: 1, matrixId: 10, column: 1 },
      },
    ],
  });

  it('shows both ports and states that the signature has no parameters', async () => {
    const host = await mount(regressionCard(), {
      inputs: [
        { portId: 'x', mode: 'cell', label: 'X', rows: 4, cols: 1, missing: false },
        { portId: 'y', mode: 'cell', label: 'Y', rows: 4, cols: 1, missing: false },
      ],
      resultMatrix: matrix(5, 1),
    });
    const ports = [...host.querySelectorAll('.formula-card__port-id')].map((p) => p.textContent);
    expect(ports).toEqual(['x', 'y']);
    // No formula editor, and it says why instead of showing an empty box.
    expect(host.querySelectorAll('.formula-card__formula-row')).toHaveLength(0);
    expect(host.textContent).toContain('此函数没有表达式参数');
    // The parameter zone is still there — it just carries a statement, not an editor.
    expect(host.querySelector('.formula-card__formulas')).not.toBeNull();
  });

  it('hides the rename entry (a signature-owned output names its own columns)', async () => {
    const host = await mount(regressionCard(), {
      inputs: [{ portId: 'x', mode: 'cell', label: 'X', rows: 4, cols: 1, missing: false }],
      resultMatrix: matrix(5, 1),
    });
    expect(host.querySelector('.formula-card__rename')).toBeNull();
  });
});

describe('an empty result zone says why it is empty', () => {
  it('says the card is not bound instead of claiming there is no expression', async () => {
    const recompute = vi.fn();
    const original = store().recomputeFormula;
    await act(async () => {
      useWorkspace.setState({ recomputeFormula: recompute });
    });
    try {
      const host = await mount(makeCard());
      const empty = host.querySelector<HTMLElement>('.formula-card__empty')!;
      expect(empty.textContent).toContain('尚未绑定后端计算节点');
      // The old copy blamed a missing expression even though one was already there.
      expect(empty.textContent).not.toContain('输入表达式');
      const button = empty.querySelector<HTMLButtonElement>('button')!;
      await act(async () => {
        button.click();
      });
      expect(recompute).toHaveBeenCalled();
    } finally {
      await act(async () => {
        useWorkspace.setState({ recomputeFormula: original });
      });
    }
  });

  it('does not offer a retry when the node computed an empty table', async () => {
    const host = await mount(makeCard({ node: { nodeId: 7, state: 'done' } }), {
      resultMatrix: new MatrixData(),
    });
    const empty = host.querySelector<HTMLElement>('.formula-card__empty')!;
    expect(empty.textContent).toContain('暂无结果');
    expect(empty.querySelector('button')).toBeNull();
  });

  it('points at the message above when the node failed', async () => {
    const host = await mount(
      makeCard({ node: { nodeId: 4, state: 'error', code: 'unknownColumn', params: { name: 'ZZ' } } }),
    );
    const empty = host.querySelector<HTMLElement>('.formula-card__empty')!;
    expect(empty.textContent).toContain('计算失败');
    expect(host.querySelector('.formula-card__error')).not.toBeNull();
  });
});

describe('the result-column menu explains a single-column table', () => {
  const openMenu = async (host: HTMLElement) => {
    const header = host.querySelector<HTMLElement>('.card--formula .vtable__colhead')!;
    await act(async () => {
      header.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 160 }),
      );
    });
    return document.querySelector<HTMLElement>('.context-menu--list')!;
  };
  const item = (menu: HTMLElement, label: string) =>
    [...menu.querySelectorAll<HTMLButtonElement>('.context-menu__item')].find(
      (button) => button.textContent?.trim() === label,
    )!;

  it('greys out the pair-based types and states the rule', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(1, 4) });
    const menu = await openMenu(host);
    expect(item(menu, '散点图').disabled).toBe(true);
    expect(item(menu, '回归图').disabled).toBe(true);
    expect(item(menu, '相关性热力图').disabled).toBe(true);
    expect(item(menu, '折线图').disabled).toBe(false);
    expect(menu.querySelector('.context-menu__hint')?.textContent).toContain('只剩 1 列');
  });

  it('surfaces a refused chart creation instead of closing silently', async () => {
    // onOpenChart returns null when the store refuses (e.g. the type needs more trailing
    // columns than the table has). The menu used to just close, which read as a dead click.
    store().clearToast();
    const host = await mount(makeCard(), {
      resultMatrix: matrix(2, 4),
      onOpenChart: () => null,
    });
    const menu = await openMenu(host);
    const line = [...menu.querySelectorAll<HTMLButtonElement>('.context-menu__item')].find(
      (button) => button.textContent?.trim() === '折线图',
    )!;
    await act(async () => {
      line.click();
    });
    const toast = store().toast;
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('折线图');
    expect(document.querySelector('.context-menu--list')).toBeNull();
  });

  it('drops the hint once two columns are available', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(2, 4) });
    const menu = await openMenu(host);
    expect(menu.querySelector('.context-menu__hint')).toBeNull();
    expect(item(menu, '散点图').disabled).toBe(false);
  });

  it('closes instead of throwing when a recompute shrinks the result under it', async () => {
    const card = makeCard();
    let shrink: (next: MatrixData) => void = () => {};
    function Harness() {
      const [result, update] = useState<MatrixData>(matrix(1, 4));
      shrink = update;
      return (
        <FormulaCard
          card={card}
          resultMatrix={result}
          sourceColumnNames={[]}
          inputs={[]}
          repoint={null}
          repointBatch={0}
          onApplyRepoint={() => {}}
          onDismissRepoint={() => {}}
          onApplyAllRepoints={() => {}}
          onRenameOutputColumn={() => {}}
          onSetColumnContract={() => {}}
          onOpenChart={() => 42}
          onOpenFunction={() => {}}
          active
          closeBlocked={false}
          onClose={() => {}}
          onCloseBlocked={() => {}}
          onActivate={() => {}}
        />
      );
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
    const header = host.querySelector<HTMLElement>('.vtable__colhead')!;
    await act(async () => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 160 }));
    });
    expect(document.querySelector('.context-menu--list')).not.toBeNull();
    await act(async () => {
      shrink(new MatrixData());
    });
    expect(document.querySelector('.context-menu--list')).toBeNull();
  });
});

describe('a header right-click stays inside the card', () => {
  it('does not reach the surrounding canvas surface', async () => {
    const host = await mount(makeCard(), { resultMatrix: matrix(2, 4) });
    const spy = vi.fn();
    document.addEventListener('contextmenu', spy);
    try {
      await act(async () => {
        host
          .querySelector('.vtable__colhead')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('contextmenu', spy);
    }
  });
});

/**
 * 结果预览（2026-10-29 决策）：默认只同步前 100 行，表格下方说明「显示前 N / 共 M 行」，
 * 并提供显式动作拉全量。这两点是"慢"的修复本身，不是装饰——165 000 行的结果默认拉全表时
 * 是 34 次往返，用户看到的是几秒钟的白屏。
 */
describe('result preview', () => {
  const previewCard = () =>
    makeCard({ result: { totalRows: 165_000, shownRows: 100, complete: false, truncated: false } });

  it('says how much of the result is shown and offers the full table', async () => {
    const host = await mount(previewCard(), { resultMatrix: matrix(1, 100) });
    const strip = host.querySelector('.formula-card__result-more');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('显示前 100 行');
    expect(strip!.textContent).toContain('165000');
    expect(strip!.querySelector('.formula-card__show-more')!.textContent).toBe('显示更多');
  });

  it('reports the stored height, not the cache height, in the output shape', async () => {
    const host = await mount(previewCard(), { resultMatrix: matrix(1, 100) });
    // 1 column × 165 000 rows — the cache only holds 100 of them.
    expect(host.querySelector('.formula-card__output-shape')!.textContent).toContain('165000');
  });

  it('drops the preview strip once the whole table is cached', async () => {
    const card = makeCard({
      result: { totalRows: 100, shownRows: 100, complete: true, truncated: false },
    });
    const host = await mount(card, { resultMatrix: matrix(1, 100) });
    expect(host.querySelector('.formula-card__result-more')).toBeNull();
  });
});
