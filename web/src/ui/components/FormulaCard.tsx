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
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { FunctionCardModel, NodeStatus } from '../types.ts';
import type { MessageKey } from '../i18n.ts';
import { CardShell } from './CardShell.tsx';
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

  /**
   * The editor keeps its own draft and only commits after a pause.
   *
   * Committing sends the params to the backend (PATCH one node), which recomputes
   * asynchronously — so committing on each keystroke would spam the server and re-render on
   * every character.
   */
  const [draft, setDraft] = useState(() =>
    card.params.formulas.map((formula) => ({ ...formula })),
  );
  const identityRef = useRef({ id: card.id, count: card.params.formulas.length });

  // Re-sync only when the card itself or the number of formulas changes; re-syncing on
  // every store update would fight the user's typing.
  useEffect(() => {
    const previous = identityRef.current;
    if (previous.id === card.id && previous.count === card.params.formulas.length) return;
    identityRef.current = { id: card.id, count: card.params.formulas.length };
    setDraft(card.params.formulas.map((formula) => ({ ...formula })));
  }, [card.id, card.params.formulas]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      draft.forEach((formula, index) => {
        const current = card.params.formulas[index];
        if (!current) return;
        if (current.name === formula.name && current.expression === formula.expression) return;
        setFormula(card.id, index, formula.name, formula.expression);
      });
    }, FORMULA_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, card.params.formulas, card.id, setFormula]);

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

  const rows = resultMatrix?.rowCount() ?? 0;
  const cols = resultMatrix?.columnCount() ?? 0;
  const title = t('card.formula', {
    name: draft[0]?.name || card.params.formulas[0]?.name || t('card.unlabeled'),
  });
  const badge = `${card.params.formulas.length} ${t('formula.columns')} · ${rows} ${t('formula.rows')}`;
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
                  <li key={input.portId} className="formula-card__port">
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
              <p className="formula-card__cols" title={sourceColumnNames.join(', ')}>
                {sourceColumnNames.slice(0, 6).join(', ')}
                {sourceColumnNames.length > 6 ? `, … (+${sourceColumnNames.length - 6})` : ''}
              </p>
            ) : null}
          </section>

          {/* ── zone 2 + 3: formulas above, outputs below ── */}
          <div className="formula-card__main">
            <section className="formula-card__formulas" aria-label={t('formula.zoneFormulas')}>
              <div className="formula-card__zone-title">{t('formula.zoneFormulas')}</div>
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
                    type="text"
                    className="formula-card__expr card__control"
                    value={formula.expression}
                    placeholder={t('formula.exprPlaceholder')}
                    aria-label={t('formula.exprPlaceholder')}
                    spellCheck={false}
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
              <button
                type="button"
                className="formula-card__add card__control"
                onClick={() => {
                  const name = `Col${draft.length + 1}`;
                  setDraft((rows) => [...rows, { name, expression: 'A' }]);
                  setFormula(card.id, draft.length, name, 'A');
                }}
              >
                + {t('formula.addColumn')}
              </button>
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
                {t('formula.zoneOutputs')}
                {cols > 0 ? (
                  <span className="formula-card__output-shape">
                    {t('formula.outputColumns', { n: cols, rows })}
                  </span>
                ) : null}
              </div>
              <ul className="formula-card__output-list">
                {card.outputs.map((output, index) => (
                  <li key={output.outputId} className="formula-card__output-item">
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
      </div>
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

/** Worst-case state across a card's nodes, for a header light (red > yellow > green > grey). */
export function aggregateNodeState(nodes: Array<NodeStatus | null>): NodeStatus['state'] | 'idle' {
  let sawDone = false;
  let sawComputing = false;
  for (const n of nodes) {
    if (!n) continue;
    if (n.state === 'error') return 'error';
    if (n.state === 'computing') sawComputing = true;
    if (n.state === 'done') sawDone = true;
  }
  if (sawComputing) return 'computing';
  if (sawDone) return 'done';
  return 'idle';
}
