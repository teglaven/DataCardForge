/**
 * Function card — a pure view over ONE backend compute node (B-plan + card schema v2).
 *
 * Three zones, as designed in the function-card review (README 函数卡 UI):
 *
 *   ┌───────────┬──────────────────────────────┐
 *   │  inputs   │  formulas (one row each)     │
 *   │  (ports)  ├──────────────────────────────┤
 *   │           │  outputs: list + result grid │
 *   └───────────┴──────────────────────────────┘
 *
 * Why the zones are real structure, not decoration:
 *   - **inputs** is the card's dependency list. v2 keeps one explicit matrix per port, so
 *     the zone can state *which file* the card reads — the thing that used to be implicit
 *     and silently changed when a table switched files.
 *   - **formulas** is the parameter bag (`params.formulas`): editing it PATCHes one node.
 *   - **outputs** are the signature's declared K outputs; the grid shows output 0's table.
 *
 * The four-state light and every error message come from the node's authoritative status:
 * `dirty | computing | done | error` → 灰/黄/绿/红. An `upstreamError` is presented as
 * **grey/invalidated** rather than red: this card's own definition is fine, its input died.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import { useTranslator, useWorkspace, type RepointOffer } from '../workspaceStore.ts';
import { registerPort, unregisterPort, type AnchorSide } from '../cardMetrics.ts';
import type { FunctionCardModel, NodeStatus } from '../types.ts';
import type { MessageKey } from '../i18n.ts';
import { CHART_TYPE_ORDER, chartTypeDef, minimumColumns, type ChartTypeId } from '../../charts/chartTypes.ts';
import { CardShell } from './CardShell.tsx';
import { HoverHelp, useHoverHelp } from './HoverHelp.tsx';
import { Popup } from './Popup.tsx';
import { VirtualTable } from './VirtualTable.tsx';

/** How long to wait after the last keystroke before re-sending each formula to the backend. */
const FORMULA_DEBOUNCE_MS = 250;

/** One resolved input port, as the left zone displays it. */
export interface ResolvedInput {
  portId: string;
  mode: 'matrix' | 'cell';
  /** Human-readable source, e.g. `b.txt` or `b.txt · column 2`. */
  label: string;
  rows: number;
  cols: number;
  /** True when the referenced matrix is gone (a dangling reference after a hand edit). */
  missing: boolean;
}

interface FormulaCardProps {
  card: FunctionCardModel;
  resultMatrix: MatrixData | undefined;
  /** Column labels of the (first) source matrix — used for the "available columns" hint. */
  sourceColumnNames: string[];
  inputs: ResolvedInput[];
  /** Pending offer to re-point at the data card's newly active file (v2: never automatic). */
  repoint: RepointOffer | null;
  /** How many cards would change if the user picks "apply to all". */
  repointBatch: number;
  onApplyRepoint: () => void;
  onDismissRepoint: () => void;
  onApplyAllRepoints: () => void;
  onRenameOutputColumn: (index: number, name: string) => void;
  onSetColumnContract: (columns: number | null) => void;
  /**
   * Create a chart from one output column. `null` means the type needs more trailing
   * columns than the table has — the caller surfaces that, exactly like a data card does.
   */
  onOpenChart: (columnIndex: number, type: ChartTypeId) => number | null;
  /** Feed this card's output into a NEW function card (a chain: A → B). */
  onOpenFunction: () => void;
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onActivate: () => void;
}

export function FormulaCard({
  card,
  resultMatrix,
  sourceColumnNames,
  inputs,
  repoint,
  repointBatch,
  onApplyRepoint,
  onDismissRepoint,
  onApplyAllRepoints,
  onRenameOutputColumn,
  onSetColumnContract,
  onOpenChart,
  onOpenFunction,
  active,
  closeBlocked,
  onClose,
  onCloseBlocked,
  onActivate,
}: FormulaCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const setFormula = useWorkspace((s) => s.setFormula);
  const removeFormula = useWorkspace((s) => s.removeFormula);
  const showToast = useWorkspace((s) => s.showToast);
  // The reference dialog is store-owned: the Help menu opens the same one, and this card
  // must not need a prop relayed through CardCanvas to reach it.
  const openHelp = useWorkspace((s) => s.openHelp);
  /**
   * Explanations sit behind a ~1 s rest (`HoverHelp`), never on a native `title`: the card
   * is dense, and instant browser tooltips fire on every accidental pass-over.
   *
   * One hook per *kind* of control, not per row: every expression row explains itself with
   * the same sentence, and hooks cannot be called inside the `draft.map`.
   */
  const nameHover = useHoverHelp(t('help.hover.name'));
  const expressionHover = useHoverHelp(t('help.hover.expr'));
  const addHover = useHoverHelp(t('help.hover.addColumn'));
  const columnsHover = useHoverHelp(t('help.columns.hint'));
  /** One ref per rendered expression input, so a column chip can insert at its caret. */
  const expressionRefs = useRef<Array<HTMLInputElement | null>>([]);
  /**
   * Register one rendered port as a connection endpoint.
   *
   * The layer anchors on `portId`, never on position (port-semantics-v1 §已锁定 1). The
   * cleanup keeps the registry honest when the list re-renders or the card goes away — a
   * stale rect would leave a wire pointing at nothing.
   */
  const portRef = (portId: string, side: AnchorSide) => (element: HTMLElement | null) => {
    if (!element) return undefined;
    registerPort(card.id, portId, element, side);
    return () => unregisterPort(card.id, portId);
  };
  /** Column header menu: pick a chart type for one output column. */
  const [chartMenu, setChartMenu] = useState<{ x: number; y: number; column: number } | null>(null);

  /**
   * The editor keeps its own draft and only commits after a pause.
   *
   * Committing sends the params to the backend (PATCH one node), which recomputes
   * asynchronously — so committing on each keystroke would spam the server and re-render on
   * every character.
   */
  /**
   * The card's expressions, or `null` when the signature has no expression parameters.
   *
   * A signature's parameters are its own business: `builtin:linear-regression` declares two
   * column ports and no expressions, so this card must render its ports and its result
   * without pretending there is an editor to show.
   */
  const formulas = Array.isArray(card.params.formulas) ? card.params.formulas : null;
  const expressionShaped = formulas !== null;

  const [draft, setDraft] = useState(() =>
    (formulas ?? []).map((formula) => ({ ...formula })),
  );
  /**
   * Rename mode: the output list turns into one name input per column.
   *
   * Committing happens on blur/Enter rather than per keystroke: the FIRST commit also
   * creates the column contract, and a contract should be a deliberate act.
   */
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState<string[]>(() =>
    (formulas ?? []).map((formula) => formula.name),
  );
  useEffect(() => {
    setNameDraft((formulas ?? []).map((formula) => formula.name));
  }, [formulas]);

  const commitName = (index: number): void => {
    const next = nameDraft[index] ?? '';
    if (next === formulas?.[index]?.name) return;
    onRenameOutputColumn(index, next);
  };

  /**
   * Insert a `Pos.N` reference at the caret of the focused expression input.
   *
   * Why `Pos.N` and not the column's own label: a chip cannot know whether the name is
   * spellable (a `/` or a space needs `[列名]`), while the position spelling always works.
   * The chip index *is* the column order — `sourceColumnNames` is built from the matrix's
   * own column list — so `Pos.${index + 1}` is exactly that column.
   *
   * The insertion target is whichever expression input has focus; with none focused the
   * first row is used, so a click still does something visible instead of nothing.
   */
  const insertPositionRef = (reference: string): void => {
    const inputs = expressionRefs.current;
    const target =
      inputs.find((element) => element !== null && element === document.activeElement) ??
      inputs.find((element) => element !== null);
    if (!target) return;
    const row = inputs.indexOf(target);
    // Read the selection BEFORE touching the draft; React replaces the input's value on
    // commit, which discards the caret position.
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    setDraft((rows) =>
      rows.map((item, index) =>
        index === row
          ? {
              ...item,
              expression: item.expression.slice(0, start) + reference + item.expression.slice(end),
            }
          : item,
      ),
    );
    // Restore focus and put the caret after the inserted text once React has committed the
    // new value — a controlled input otherwise leaves the caret wherever it lands.
    const caret = start + reference.length;
    window.setTimeout(() => {
      target.focus();
      target.setSelectionRange(caret, caret);
    }, 0);
  };
  const identityRef = useRef({ id: card.id, count: (formulas ?? []).length });

  // Re-sync only when the card itself or the number of formulas changes; re-syncing on
  // every store update would fight the user's typing.
  useEffect(() => {
    const previous = identityRef.current;
    if (previous.id === card.id && previous.count === (formulas ?? []).length) return;
    identityRef.current = { id: card.id, count: (formulas ?? []).length };
    setDraft((formulas ?? []).map((formula) => ({ ...formula })));
  }, [card.id, formulas]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      draft.forEach((formula, index) => {
        const current = formulas?.[index];
        if (!current) return;
        if (current.name === formula.name && current.expression === formula.expression) return;
        setFormula(card.id, index, formula.name, formula.expression);
      });
    }, FORMULA_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, formulas, card.id, setFormula]);

  /**
   * The card-level error text, straight from the node's structured status.
   *
   * No local `compile()`: the backend's parse is the authority. Its error `code` maps to an
   * i18n key; an unknown code still shows something (generic sentence + raw code) rather
   * than silently swallowing the failure.
   */
  const error = useMemo(() => {
    const status: NodeStatus | null = card.node;
    if (!status || status.state !== 'error') return null;
    const code = status.code ?? 'internalError';
    const params = normaliseErrorParams(status.params);
    const key = `formula.error.${code}` as MessageKey;
    const localised = t(key, params);
    const message = localised === key ? `${t('formula.error.unknown')} (${code})` : localised;
    return { code, message };
  }, [card.node, t]);

  /** `upstreamError` means "this card is fine, its input died" ⇒ invalidated, not red. */
  const invalidated = error?.code === 'upstreamError';
  const contract = card.params.columnContract;
  const violation = error?.code === 'columnContractViolation' ? error : null;
  const violationExpected = Number(card.node?.params?.expected ?? NaN);
  const violationActual = Number(card.node?.params?.actual ?? NaN);

  const rows = resultMatrix?.rowCount() ?? 0;
  const cols = resultMatrix?.columnCount() ?? 0;
  const title = t('card.formula', {
    name: draft[0]?.name || formulas?.[0]?.name || t('card.unlabeled'),
  });
  const badge = expressionShaped
    ? `${(formulas ?? []).length} ${t('formula.columns')} · ${rows} ${t('formula.rows')}`
    : `${card.signatureId.replace(/^builtin:/, '')} · ${rows} ${t('formula.rows')}`;
  const state: NodeStatus['state'] | 'idle' | 'stale' = invalidated
    ? 'stale'
    : (card.node?.state ?? 'idle');

  return (
    <CardShell
      card={card}
      variant="card--formula"
      title={title}
      badge={badge}
      active={active}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      onBounds={(bounds) => setBounds(card.id, bounds)}
    >
      <div className="formula-card">
        <div className="formula-card__zones">
          {/* ── zone 1: inputs (the card's dependency list) ── */}
          <section className="formula-card__inputs" aria-label={t('formula.zoneInputs')}>
            <div className="formula-card__zone-title">
              {t('formula.zoneInputs')}
              <span className={`node-light node-light--${state}`} aria-hidden />
            </div>
            {inputs.length === 0 ? (
              <p className="formula-card__zone-empty">{t('formula.noInput')}</p>
            ) : (
              <ul className="formula-card__port-list">
                {inputs.map((input) => (
                  <li
                    key={input.portId}
                    className="formula-card__port"
                    ref={portRef(input.portId, 'left')}
                  >
                    <span className="formula-card__port-id" title={input.portId}>
                      {input.portId}
                    </span>
                    <span
                      className={`formula-card__mode formula-card__mode--${input.mode}`}
                      title={input.mode}
                    >
                      {input.mode === 'matrix' ? t('formula.modeMatrix') : t('formula.modeCell')}
                    </span>
                    <span
                      className={`formula-card__port-src${input.missing ? ' formula-card__port-src--missing' : ''}`}
                    >
                      {input.missing ? t('formula.inputMissing') : input.label}
                    </span>
                    {!input.missing && input.rows > 0 ? (
                      <span className="formula-card__port-shape">
                        {input.rows}×{input.cols}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {sourceColumnNames.length > 0 ? (
              // Clickable chips rather than a truncated text line: the one thing a new user
              // needs is "the column is called Pos.3", and typing that by hand from a
              // truncated string is where the placeholder used to fail them. The list order
              // is column order, so each chip knows its own `Pos.N`.
              //
              // The chip prints the spelling it inserts (`Pos.1`) *next to* the printed
              // name, because "this column is Pos.1 and its name is 时间_秒" is the whole
              // lesson; printing only the name taught nothing, and only the first six
              // columns were reachable at all — a 10-column table left columns 7–10 with no
              // way to discover their number.
              <div className="formula-card__cols" {...columnsHover.anchorProps}>
                {sourceColumnNames.map((name, index) => {
                  const pos = `Pos.${index + 1}`;
                  return (
                    <button
                      key={`${index}:${name}`}
                      type="button"
                      className="formula-card__col-chip card__control"
                      aria-label={t('help.chip.insert', { pos, name })}
                      // Keep the caret where the user left it: without this the mousedown
                      // moves focus to the chip and the expression input blurs first.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertPositionRef(pos)}
                      disabled={!expressionShaped}
                    >
                      <span className="formula-card__col-chip-pos">{pos}</span>
                      {/* A header-less table's annotation *is* "Pos.3"; printing it twice
                          says nothing. */}
                      {name === pos ? null : (
                        <span className="formula-card__col-chip-name">{name}</span>
                      )}
                    </button>
                  );
                })}
                {columnsHover.tooltip}
              </div>
            ) : null}
          </section>

          {/* ── zone 2 + 3: formulas above, outputs below ── */}
          <div className="formula-card__main">
            <section className="formula-card__formulas" aria-label={t('formula.zoneFormulas')}>
              <div className="formula-card__zone-title">
                <span className="formula-card__zone-name">
                  {expressionShaped ? t('formula.zoneFormulas') : t('formula.zoneParams')}
                </span>
                {/* The reference lives one click away from where it is needed. There is no
                    prop for this: the dialog is store state, so CardCanvas stays unaware.
                    The wrapper form is fine here — an inline span around a button changes
                    no layout; the inputs below use the hook instead. */}
                <HoverHelp
                  text={t('help.hover.openHelp')}
                  className="formula-card__help-wrap"
                >
                  <button
                    type="button"
                    className="formula-card__help card__control"
                    aria-label={t('help.title')}
                    onClick={() => openHelp('functions')}
                  >
                    ?
                  </button>
                </HoverHelp>
              </div>
              {!expressionShaped ? (
                <p className="formula-card__no-params">
                  {t('formula.noParams', { signature: card.signatureId.replace(/^builtin:/, '') })}
                </p>
              ) : null}
              {draft.map((formula, index) => (
                <div
                  key={index}
                  className={`formula-card__row${error ? ' formula-card__row--error' : ''}`}
                >
                  <input
                    type="text"
                    className="formula-card__name card__control"
                    value={formula.name}
                    placeholder={t('formula.namePlaceholder')}
                    aria-label={t('formula.namePlaceholder')}
                    {...nameHover.anchorProps}
                    onChange={(e) =>
                      setDraft((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, name: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  <span className="formula-card__eq">=</span>
                  <input
                    ref={(element) => {
                      expressionRefs.current[index] = element;
                    }}
                    type="text"
                    className="formula-card__expr card__control"
                    value={formula.expression}
                    placeholder={t('formula.exprPlaceholder')}
                    aria-label={t('formula.exprPlaceholder')}
                    spellCheck={false}
                    {...expressionHover.anchorProps}
                    onChange={(e) =>
                      setDraft((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, expression: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  {draft.length > 1 ? (
                    <button
                      type="button"
                      className="formula-card__remove card__control"
                      title={t('formula.remove')}
                      aria-label={t('formula.remove')}
                      onClick={() => removeFormula(card.id, index)}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              {/* One tooltip per kind of control, rendered once: every row shares the same
                  sentence, and a hook cannot be called inside the map above. */}
              {nameHover.tooltip}
              {expressionHover.tooltip}
              <button
                type="button"
                className="formula-card__add card__control"
                {...addHover.anchorProps}
                onClick={() => {
                  const name = `Col${draft.length + 1}`;
                  setDraft((rows) => [...rows, { name, expression: 'A' }]);
                  setFormula(card.id, draft.length, name, 'A');
                }}
              >
                + {t('formula.addColumn')}
              </button>
              {addHover.tooltip}
              {error ? (
                <p className="formula-card__error" role="alert">
                  {error.message}
                </p>
              ) : null}
              {invalidated ? (
                <p className="formula-card__stale">{t('formula.staleUpstream')}</p>
              ) : null}
            </section>

            <section className="formula-card__outputs" aria-label={t('formula.zoneOutputs')}>
              <div className="formula-card__zone-title">
                <span>{t('formula.zoneOutputs')}</span>
                <span className="formula-card__zone-tools">
                  {cols > 0 ? (
                    <span className="formula-card__output-shape">
                      {t('formula.outputColumns', { n: cols, rows })}
                    </span>
                  ) : null}
                  {expressionShaped ? (
                    <button
                      type="button"
                      className={`card__control formula-card__rename${renaming ? ' is-open' : ''}`}
                      aria-pressed={renaming}
                      onClick={() => setRenaming((open) => !open)}
                    >
                      {renaming ? t('formula.renameDone') : t('formula.rename')}
                    </button>
                  ) : null}
                </span>
              </div>
              {renaming ? (
                <ul className="formula-card__rename-list">
                  {(formulas ?? []).map((_formula, index) => (
                    <li key={index} className="formula-card__rename-item">
                      <span className="formula-card__rename-index">{index + 1}</span>
                      <input
                        type="text"
                        className="formula-card__rename-input card__control"
                        value={nameDraft[index] ?? ''}
                        placeholder={t('formula.renamePlaceholder', { n: index + 1 })}
                        aria-label={t('formula.renamePlaceholder', { n: index + 1 })}
                        onChange={(e) =>
                          setNameDraft((names) =>
                            names.map((name, i) => (i === index ? e.target.value : name)),
                          )
                        }
                        onBlur={() => commitName(index)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {repoint ? (
                <div className="formula-card__repoint" role="status">
                  <p className="formula-card__repoint-title">
                    {t('formula.repoint.title', { name: repoint.toName })}
                  </p>
                  <p className="formula-card__repoint-diff">
                    {repoint.sameColumns
                      ? t('formula.repoint.sameColumns', {
                          n: repoint.toCols,
                          from: repoint.fromRows,
                          to: repoint.toRows,
                        })
                      : t('formula.repoint.changedColumns', {
                          added: repoint.addedLabels.join(', ') || '—',
                          removed: repoint.removedLabels.join(', ') || '—',
                          from: repoint.fromRows,
                          to: repoint.toRows,
                        })}
                  </p>
                  <div className="formula-card__repoint-actions">
                    <button
                      type="button"
                      className="card__control formula-card__repoint-primary"
                      onClick={onApplyRepoint}
                    >
                      {repoint.sameColumns
                        ? t('formula.repoint.apply')
                        : t('formula.repoint.applyAnyway')}
                    </button>
                    <button
                      type="button"
                      className="card__control"
                      onClick={onDismissRepoint}
                    >
                      {t('formula.repoint.dismiss')}
                    </button>
                    {repointBatch > 1 ? (
                      <button
                        type="button"
                        className="card__control"
                        onClick={onApplyAllRepoints}
                      >
                        {t('formula.repoint.applyAll', { n: repointBatch })}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <ul className="formula-card__output-list">
                {card.outputs.map((output, index) => (
                  <li
                    key={output.outputId}
                    className="formula-card__output-item"
                    ref={portRef(output.outputId, 'right')}
                  >
                    <span className="formula-card__output-id">
                      {index === 0 ? t('formula.outputName') : output.outputId}
                    </span>
                    <span className="formula-card__output-cols">
                      {cols > 0
                        ? t('formula.outputColumns', { n: cols, rows })
                        : t('formula.outputEmpty')}
                    </span>
                  </li>
                ))}
              </ul>
              {resultMatrix && cols > 0 ? (
                <div className="formula-card__grid">
                  <VirtualTable
                    matrix={resultMatrix}
                    readOnly
                    rowLabel={(n) => t('table.rowHeader', { n })}
                    onHeaderContextMenu={(event, column) => {
                      event.preventDefault();
                      setChartMenu({ x: event.clientX, y: event.clientY, column });
                    }}
                  />
                </div>
              ) : (
                <div className="formula-card__empty">
                  {state === 'computing' || state === 'dirty'
                    ? t('formula.pending')
                    : t('formula.empty')}
                </div>
              )}
            </section>
          </div>
        </div>

        {/* Bottom hint bar: the column contract in words, plus the way out of a violation.
            It is always present while a contract exists, so the promise is never invisible. */}
        {(contract || violation || renaming) ? (
          <div className={`formula-card__hintbar${violation ? ' formula-card__hintbar--violation' : ''}`}>
            {violation ? (
              <>
                <span className="formula-card__hintbar-text">
                  {t('formula.contractViolation', {
                    expected: violationExpected,
                    actual: violationActual,
                  })}
                </span>
                {Number.isFinite(violationActual) ? (
                  <button
                    type="button"
                    className="card__control"
                    onClick={() => onSetColumnContract(violationActual)}
                  >
                    {t('formula.contractExtend', { n: violationActual })}
                  </button>
                ) : null}
                <button type="button" className="card__control" onClick={() => onSetColumnContract(null)}>
                  {t('formula.contractClear')}
                </button>
              </>
            ) : contract ? (
              <>
                <span className="formula-card__hintbar-text">
                  {t('formula.contractLocked', { n: contract.columns })}
                </span>
                <button type="button" className="card__control" onClick={() => onSetColumnContract(null)}>
                  {t('formula.contractClear')}
                </button>
              </>
            ) : (
              <span className="formula-card__hintbar-text">{t('formula.contractNone')}</span>
            )}
          </div>
        ) : null}
      </div>

      {chartMenu && resultMatrix ? (
        <Popup
          x={chartMenu.x}
          y={chartMenu.y}
          className="context-menu context-menu--list"
          onDismiss={() => setChartMenu(null)}
        >
          <div className="context-menu__title">
            {t('table.contextChartMenu')} ·{' '}
            {resultMatrix.columnLabel(chartMenu.column) ||
              resultMatrix.column(chartMenu.column).posName}
          </div>
          {CHART_TYPE_ORDER.map((id) => {
            const def = chartTypeDef(id);
            // A chart is built from this column *and the ones after it*, so the test is
            // against the remaining columns — not the table's total.
            const remaining = cols - chartMenu.column;
            const enough = minimumColumns(id) <= remaining;
            return (
              <button
                key={id}
                type="button"
                className="context-menu__item"
                title={
                  enough
                    ? t(def.hintKey)
                    : t('status.needTrailingColumns', {
                        type: t(def.labelKey),
                        n: minimumColumns(id),
                        have: remaining,
                      })
                }
                disabled={!enough}
                onClick={() => {
                  const created = onOpenChart(chartMenu.column, id);
                  if (created === null) {
                    showToast(
                      'error',
                      t('status.needTrailingColumns', {
                        type: t(def.labelKey),
                        n: minimumColumns(id),
                        have: remaining,
                      }),
                    );
                  } else {
                    showToast('info', t('status.chartCreated', {
                      name: resultMatrix.columnLabel(chartMenu.column),
                    }));
                  }
                  setChartMenu(null);
                }}
              >
                {t(def.labelKey)}
              </button>
            );
          })}
          <div className="context-menu__separator" />
          <button
            type="button"
            className="context-menu__item"
            onClick={() => {
              onOpenFunction();
              setChartMenu(null);
            }}
          >
            {t('menu.newFormula')}
          </button>
        </Popup>
      ) : null}
    </CardShell>
  );
}

/** Collapse the exact-arity phrasing and pass through the backend's structured params. */
function normaliseErrorParams(params?: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  // `badArgCount` renders "2–2 arguments" badly; collapse an exact arity to one number.
  if (out.min !== undefined && out.max !== undefined && out.min === out.max) {
    out.expected = String(out.min);
  }
  return out;
}
