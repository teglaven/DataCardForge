/**
 * @vitest-environment jsdom
 *
 * The help surface: the reference dialog (opened from the Help menu and from the formula
 * card's "?", listing every engine function) and the delayed hover tooltip.
 *
 * Each assertion pins a decision rather than a pixel:
 *   - the catalogue must cover `FUNCTIONS` exactly, so changing the engine without
 *     updating the documentation fails here instead of shipping stale help;
 *   - the same dialog serves two unrelated entry points, which is why the open state is
 *     store-owned (the card gets no prop from CardCanvas);
 *   - a hover tooltip is *earned by resting*: it must not appear for a quick pass-over,
 *     and it opens at the pointer rather than at the element edge.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { FUNCTIONS } from '../src/core/expression.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { HELP_FUNCTION_GROUPS } from '../src/ui/formulaHelp.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';
import { HelpDialog } from '../src/ui/components/HelpDialog.tsx';
import { MenuBar } from '../src/ui/components/MenuBar.tsx';
import { FormulaCard } from '../src/ui/components/FormulaCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];
const store = () => useWorkspace.getState();

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<StrictMode>{node}</StrictMode>);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

function matrix(columns: number, rows = 4): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, Array.from({ length: rows }, (_, r) => r + c));
  }
  return mat;
}

/** Create a real function card through the store, with optional model overrides. */
function makeCard(overrides: Partial<FunctionCardModel> = {}): FunctionCardModel {
  const matrixCardId = store().addMatrixCard([{ name: 'b.csv', matrix: matrix(3) }]);
  const cardId = store().addFormulaCard(matrixCardId);
  const card = store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
  return { ...card, ...overrides };
}

async function mountFormulaCard(
  card: FunctionCardModel,
  sourceColumnNames: string[] = [],
): Promise<HTMLElement> {
  return mount(
    <>
      <FormulaCard
        card={card}
        resultMatrix={undefined}
        sourceColumnNames={sourceColumnNames}
        inputs={[]}
        repoint={null}
        repointBatch={0}
        onApplyRepoint={() => {}}
        onDismissRepoint={() => {}}
        onApplyAllRepoints={() => {}}
        onRenameOutputColumn={() => {}}
        onSetColumnContract={() => {}}
        onOpenChart={() => null}
        onOpenFunction={() => {}}
        active
        closeBlocked={false}
        onClose={() => {}}
        onCloseBlocked={() => {}}
        onActivate={() => {}}
      />
      <HelpDialog />
    </>,
  );
}

function mountMenuAndDialog(): Promise<HTMLElement> {
  const noop = () => {};
  return mount(
    <>
      <MenuBar
        onNewTable={noop}
        onOpenWorkspace={noop}
        onSaveWorkspace={noop}
        onExportCsv={noop}
        onExportAllCharts={noop}
        onTile={noop}
        onCascade={noop}
        onResetView={noop}
        onCloseAll={noop}
        canExport={false}
        hasCharts={false}
      />
      <HelpDialog />
    </>,
  );
}

/** Click the top-level menu whose label is `label` (menu bar markup is a plain button list). */
async function openMenu(label: string): Promise<void> {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('.menubar__trigger')].find(
    (button) => button.textContent === label,
  );
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger!.click();
  });
}

async function clickMenuItem(labelPart: string): Promise<void> {
  const item = [...document.querySelectorAll<HTMLButtonElement>('.menubar__item')].find((button) =>
    button.textContent?.includes(labelPart),
  );
  expect(item).toBeDefined();
  await act(async () => {
    item!.click();
  });
}

beforeEach(() => {
  store().reset();
  // jsdom's navigator.language is en-US; pin the locale the assertions read.
  store().setLocale('zh');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('formula help catalogue', () => {
  it('documents exactly the engine’s built-in functions', () => {
    const documented = HELP_FUNCTION_GROUPS.flatMap((group) =>
      group.items.map((item) => item.name),
    ).sort();
    // The oracle is `FUNCTIONS` in core/expression.ts — the TS reference the C++ engine is
    // diffed against, i.e. the *cell-mode* set. The C++ `functions()` additionally holds the
    // matrix-mode-only names (TRANSPOSE/DET/INV/SOLVE/MMUL/EMUL); cell mode rejects them, so
    // advertising them here would teach the user functions their card cannot call. The
    // dialog's function note says so explicitly, which is what keeps this claim honest.
    // Equality in both directions: a missing entry means undocumented help, an extra one
    // means the help teaches a function the engine will reject.
    expect(documented).toEqual(Object.keys(FUNCTIONS).sort());
  });
});

describe('help dialog', () => {
  it('opens from the Help menu and lists every engine function', async () => {
    await mountMenuAndDialog();
    expect(document.querySelector('.help-dialog')).toBeNull();

    await openMenu('帮助');
    await clickMenuItem('公式与函数说明');

    const dialog = document.querySelector('.help-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('列引用写法');
    for (const name of Object.keys(FUNCTIONS)) {
      expect(dialog!.textContent).toContain(name);
    }
  });

  it('opens at the section the menu item asked for', async () => {
    await mountMenuAndDialog();
    await openMenu('帮助');
    await clickMenuItem('常见报错');

    const target = document.querySelector('.help-dialog__section--target');
    expect(target?.getAttribute('data-section')).toBe('errors');
    expect(store().helpSection).toBe('errors');
  });

  it('states the limits the reference has: leading digits and matrix-only functions', async () => {
    // The user's own failure was `地面速度_μm/s`, and an equally common lab header starts with
    // a digit (`2号测点`). Both are unspellable bare, so the syntax table must say it, and the
    // function note must admit the matrix-mode names it deliberately omits.
    await mountMenuAndDialog();
    await openMenu('帮助');
    await clickMenuItem('公式与函数说明');
    const text = document.querySelector('.help-dialog')!.textContent ?? '';
    expect(text).toContain('[2号测点]');
    expect(text).toContain('TRANSPOSE');
  });

  it('opens from the formula card’s "?" at the function section', async () => {
    const host = await mountFormulaCard(makeCard());
    const help = host.querySelector<HTMLButtonElement>('.formula-card__help');
    expect(help).not.toBeNull();
    expect(help!.getAttribute('aria-label')).toContain('公式与函数说明');

    await act(async () => {
      help!.click();
    });

    expect(store().helpOpen).toBe(true);
    expect(store().helpSection).toBe('functions');
    const dialog = document.querySelector('.help-dialog');
    expect(dialog).not.toBeNull();
    expect(document.querySelector('.help-dialog__section--target')?.getAttribute('data-section')).toBe(
      'functions',
    );
  });

  it('closes on Escape', async () => {
    await mountMenuAndDialog();
    await openMenu('帮助');
    await clickMenuItem('公式与函数说明');
    expect(document.querySelector('.help-dialog')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(document.querySelector('.help-dialog')).toBeNull();
    expect(store().helpOpen).toBe(false);
  });

  it('closes on the × button and on a backdrop click', async () => {
    await mountMenuAndDialog();
    await openMenu('帮助');
    await clickMenuItem('列引用写法');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('.help-dialog__close')!.click();
    });
    expect(document.querySelector('.help-dialog')).toBeNull();

    await openMenu('帮助');
    await clickMenuItem('列引用写法');
    expect(document.querySelector('.help-dialog')).not.toBeNull();

    // A click on the backdrop itself closes; a click inside the panel does not.
    await act(async () => {
      document.querySelector<HTMLElement>('.help-dialog__title')!.click();
    });
    expect(document.querySelector('.help-dialog')).not.toBeNull();

    await act(async () => {
      document.querySelector<HTMLElement>('.help-dialog__backdrop')!.click();
    });
    expect(document.querySelector('.help-dialog')).toBeNull();
  });
});

describe('available-column chips', () => {
  it('inserts Pos.N at the caret of the focused expression input', async () => {
    const card = makeCard({
      params: { formulas: [{ name: 'out', expression: 'IF( > 0, 1, 0)' }] },
    });
    const host = await mountFormulaCard(card, ['时间_秒', 'snr_dB']);
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.formula-card__col-chip')];
    expect(chips).toHaveLength(2);

    const expr = host.querySelector<HTMLInputElement>('.formula-card__expr')!;
    await act(async () => {
      expr.focus();
      // Caret inside the argument list: the insertion must land there, not at the end.
      expr.setSelectionRange(3, 3);
    });
    await act(async () => {
      chips[0].click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(expr.value).toBe('IF(Pos.1 > 0, 1, 0)');
    // The caret ends up right after the inserted reference, so typing continues there.
    expect(expr.selectionStart).toBe(3 + 'Pos.1'.length);

    // A second chip appends the next column at the current caret (the end of the text).
    await act(async () => {
      expr.setSelectionRange(expr.value.length, expr.value.length);
    });
    await act(async () => {
      chips[1].click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(expr.value).toBe('IF(Pos.1 > 0, 1, 0)Pos.2');
  });

  it('replaces the expression when no input is focused', async () => {
    // With nothing focused the chip means "use this column": appending produced
    // `时间_秒 * 2Pos.2` and a red card, from the control that exists to teach `Pos.N`.
    const card = makeCard({ params: { formulas: [{ name: 'out', expression: '时间_秒 * 2' }] } });
    const host = await mountFormulaCard(card, ['时间_秒', 'snr_dB']);
    const expr = host.querySelector<HTMLInputElement>('.formula-card__expr')!;
    (document.activeElement as HTMLElement | null)?.blur?.();
    await act(async () => {
      expr.blur();
    });
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.formula-card__col-chip')];
    await act(async () => {
      chips[1].click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(expr.value).toBe('Pos.2');
  });

  it('prints the reference it inserts, and lists every column', async () => {
    // Printing only the annotation taught nothing about what a click inserts, and the
    // 6-chip cap left columns 7+ of a 10-column table with no way to learn their number.
    const names = Array.from({ length: 9 }, (_, i) => `sensor_${i + 1}`);
    const card = makeCard({ params: { formulas: [{ name: 'out', expression: '1' }] } });
    const host = await mountFormulaCard(card, names);
    const chips = [...host.querySelectorAll<HTMLButtonElement>('.formula-card__col-chip')];
    expect(chips).toHaveLength(names.length);
    expect(chips[0].textContent).toContain('Pos.1');
    expect(chips[0].textContent).toContain('sensor_1');
    expect(chips[8].textContent).toContain('Pos.9');
  });
});

describe('delayed hover tooltip', () => {
  /** jsdom has no PointerEvent and hover is a mouse/pen-only concept: use mouse events. */
  function hover(element: Element, type: 'mouseover' | 'mouseout', x = 0, y = 0): void {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, relatedTarget: null }),
    );
  }

  it('appears only after the rest delay, at the pointer position', async () => {
    const host = await mountFormulaCard(makeCard());
    const input = host.querySelector<HTMLInputElement>('.formula-card__expr')!;
    expect(document.querySelector('.hover-help')).toBeNull();

    // Arm the timer only now: mounting itself uses real timers.
    vi.useFakeTimers();
    await act(async () => {
      hover(input, 'mouseover', 120, 80);
    });

    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(document.querySelector('.hover-help')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const tip = document.querySelector<HTMLElement>('.hover-help');
    expect(tip).not.toBeNull();
    expect(tip!.getAttribute('role')).toBe('tooltip');
    // The text is the reference-syntax one-liner, not the native title.
    expect(tip!.textContent).toContain('Pos.1 * 2');

    // Fixed coordinates near the pointer (the hook offsets by a small gap).
    const left = Number.parseFloat(tip!.style.left);
    const top = Number.parseFloat(tip!.style.top);
    expect(left).toBeGreaterThanOrEqual(120);
    expect(left).toBeLessThan(120 + 30);
    expect(top).toBeGreaterThanOrEqual(80);
    expect(top).toBeLessThan(80 + 30);
  });

  it('never appears for a quick pass-over', async () => {
    const host = await mountFormulaCard(makeCard());
    const input = host.querySelector<HTMLInputElement>('.formula-card__expr')!;

    vi.useFakeTimers();
    await act(async () => {
      hover(input, 'mouseover', 100, 100);
    });
    // Leaving before the delay elapses cancels the pending tooltip.
    await act(async () => {
      hover(input, 'mouseout');
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(document.querySelector('.hover-help')).toBeNull();
  });

  it('dismisses an open tooltip on Escape', async () => {
    const host = await mountFormulaCard(makeCard());
    const input = host.querySelector<HTMLInputElement>('.formula-card__expr')!;

    vi.useFakeTimers();
    await act(async () => {
      hover(input, 'mouseover', 60, 60);
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector('.hover-help')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('.hover-help')).toBeNull();
  });
});
