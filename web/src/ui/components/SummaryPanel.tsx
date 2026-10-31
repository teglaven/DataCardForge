/**
 * Summary panel (摘要) — the collapsible bar at the bottom of a DATA card and a FUNCTION
 * card. It is the frontend of `builtin:summary`
 * (docs/decisions/2026-10-27-summary-builtin.md, P2).
 *
 * Four decisions this file embodies, each of which is easy to undo by accident:
 *
 *   - **Nothing is computed here.** The panel prints what the backend's result matrix
 *     holds; the only trigger is `POST /api/nodes/{id}/compute` (the store's
 *     `computeSummary`). A number that appears on screen therefore always came from the
 *     one implementation of the statistic (the expression engine).
 *   - **Row identity is the catalog id.** Rows are rendered as the raw ids (`n`, `nan`,
 *     `mean`, …) in catalog order. They are NOT translated: the transport has no row-label
 *     channel, so the id + its position IS the identity (decision §七 — an explicit gap,
 *     not an oversight).
 *   - **The four states come from the node's status, not from a local diff.** `dirty` +
 *     `reason` distinguishes 未请求 (`notRequested`) from 待重算 (`upstreamChanged` /
 *     `definitionChanged`); `computing` / `done` / `error` are the backend's own names.
 *   - **A stale panel prints no numbers at all.** The backend empties the result matrix
 *     when it marks a node dirty, and this component drops its cached table on the same
 *     event — so 待重算 can never keep showing yesterday's mean (and never a row of `0`s).
 *
 * The panel's own state (open, the statistic filter, the node id) lives in the store as
 * session-only state; nothing about it is persisted on the card or in the workspace file.
 */
import { useMemo } from 'react';

import { formatCell } from '../../core/numeric.ts';
import type { MessageKey } from '../i18n.ts';
import { isFormulaCard, isMatrixCard, type CardModel } from '../types.ts';
import { downloadText } from '../fileActions.ts';
import {
  SUMMARY_STATS,
  useTranslator,
  useWorkspace,
  type SummaryPanelEntry,
  type SummaryResultTable,
} from '../workspaceStore.ts';

/** The four visible states (+ `error`), derived from the backend's node status. */
export type SummaryView = 'notRequested' | 'computing' | 'stale' | 'done' | 'error';

/**
 * Map one panel entry onto the four visible states.
 *
 * `idle` means "no node exists yet", which is the same thing the backend would call
 * `dirty` + `notRequested` — the lazy signature is born uncomputed (decision §四), so the
 * panel must not pretend it has data just because no node was ever created.
 */
export function summaryViewOf(entry: SummaryPanelEntry | undefined): SummaryView {
  if (!entry || entry.status === 'idle') return 'notRequested';
  if (entry.status === 'computing') return 'computing';
  if (entry.status === 'done') return 'done';
  if (entry.status === 'error') return 'error';
  // `dirty`: `notRequested` is the lazy signature's birth state; the other two reasons mean
  // "the numbers on screen would not describe the current input".
  return entry.reason === undefined || entry.reason === 'notRequested' ? 'notRequested' : 'stale';
}

/**
 * CSV text for one summary table.
 *
 * Header row = the selected input variables; one row per statistic in catalog order, first
 * cell = the stat id. Values keep full precision (like `matrixToCsv`) because a file is for
 * reuse, while the table on screen is rounded for reading by `formatCell`.
 *
 * Exported and pure on purpose: the download itself is a DOM side effect, the text is the
 * half that has to be judged value by value.
 */
export function summaryCsv(result: SummaryResultTable): string {
  const lines: string[] = [result.columns.map(csvField).join(',')];
  result.stats.forEach((id, row) => {
    const values = result.rows[row] ?? [];
    const cells = result.columns.map((_, column) => csvText(values[column]));
    lines.push([id, ...cells].map(csvField).join(','));
  });
  // BOM like every other CSV this app writes, so a Chinese column label survives Excel.
  return `\ufeff${lines.join('\n')}`;
}

function csvText(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '';
  return String(value);
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * File-name stem for the export: the source file's name for a data card, the signature's
 * slug for a function card. Path separators cannot appear in a download name.
 */
function csvBaseName(card: CardModel): string {
  const raw = isMatrixCard(card)
    ? (card.sources[card.activeSource]?.name ?? 'table')
    : isFormulaCard(card)
      ? card.signatureId.replace(/^builtin:/, '')
      : 'table';
  const stem = raw.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return stem === '' ? 'table' : stem;
}

interface SummaryPanelProps {
  card: CardModel;
}

export function SummaryPanel({ card }: SummaryPanelProps) {
  const { t } = useTranslator();
  const entry = useWorkspace((s) => s.summaries[card.id]);
  const setOpen = useWorkspace((s) => s.setSummaryOpen);
  const toggleStat = useWorkspace((s) => s.toggleSummaryStat);
  const compute = useWorkspace((s) => s.computeSummary);

  const view = summaryViewOf(entry);
  const open = entry?.open ?? false;

  /**
   * Whether there is a table to summarise at all.
   *
   * A data card always has one (its active file). A function card can only be summarised
   * once its own node has produced a result — the summary node reads that result matrix,
   * so asking earlier would bind a node to a matrix that does not exist yet.
   */
  const hasSource = isMatrixCard(card)
    ? card.sources.length > 0
    : isFormulaCard(card) && card.node?.state === 'done';
  const canCompute = hasSource && view !== 'computing';

  /**
   * Error text, mirroring the function card: the backend sends a structured `code`, the
   * sentence comes from i18n. The panel has no structured `params` channel to fill in, so a
   * message that still contains a placeholder degrades to the generic sentence + the code
   * rather than printing `「{name}」` at the user.
   */
  const error = useMemo(() => {
    if (!entry || entry.status !== 'error') return null;
    const code = entry.code ?? 'internalError';
    const key = `formula.error.${code}` as MessageKey;
    const localised = t(key);
    const usable = localised !== key && !/\{\w+\}/.test(localised);
    return usable ? localised : `${t('formula.error.unknown')} (${code})`;
  }, [entry, t]);

  /** The cached table, or null; a `done` panel always has one (the pull sets it). */
  const result = entry?.result ?? null;

  const statusText =
    view === 'notRequested'
      ? hasSource
        ? t('summary.notRequested')
        : t('summary.noSource')
      : view === 'computing'
        ? t('summary.computing')
        : view === 'done'
          ? t('summary.computedAt', {
              // Local time: there is no computed-at field in the protocol (the status DTO
              // carries none), so the panel says out loud that this clock is the browser's.
              time: entry?.computedAt
                ? new Date(entry.computedAt).toLocaleTimeString(undefined, { hour12: false })
                : '—',
            })
          : view === 'stale'
            ? entry?.reason === 'definitionChanged'
              ? t('summary.staleDefinition')
              : t('summary.staleUpstream')
            : (error ?? t('formula.error.unknown'));

  const download = (): void => {
    if (!result) return;
    downloadText(`summary-${csvBaseName(card)}.csv`, summaryCsv(result), 'text/csv;charset=utf-8');
  };

  // Collapsed: a thin rail, like the chart card's column dock — but with its own state, so
  // opening the summary never opens (or closes) the chart's column picker.
  if (!open) {
    return (
      <div className="summary-panel summary-panel--collapsed">
        <button
          type="button"
          className="summary-panel__toggle card__control"
          aria-expanded={false}
          aria-controls={`summary-panel-${card.id}`}
          title={t('summary.title')}
          onClick={() => setOpen(card.id, true)}
        >
          <span className={`summary-panel__lamp summary-panel__lamp--${view}`} aria-hidden />
          <span className="summary-panel__label">{t('summary.title')}</span>
        </button>
      </div>
    );
  }

  /** The statistic filter: a FILTER over the catalog, never a reordering (§五). */
  const statPicker = (
    <div className="summary-panel__stats" role="group" aria-label={t('summary.stats')}>
      <span className="summary-panel__stats-title">{t('summary.stats')}</span>
      {SUMMARY_STATS.map((stat) => {
        const checked = entry?.stats.includes(stat) ?? true;
        // Never empty: `stats: []` is `badSignatureParams` on the wire, and "no rows" is
        // not a state this panel has (same rule as the column dock's last column).
        const lastOne = checked && (entry?.stats.length ?? SUMMARY_STATS.length) <= 1;
        return (
          <label
            key={stat}
            className="summary-panel__stat-option"
            title={lastOne ? t('summary.statsLast') : stat}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={lastOne}
              onChange={() => toggleStat(card.id, stat)}
            />
            <span className="summary-panel__stat-name">{stat}</span>
          </label>
        );
      })}
    </div>
  );

  return (
    <section
      className="summary-panel summary-panel--open"
      id={`summary-panel-${card.id}`}
      aria-label={t('summary.title')}
    >
      <div className={`summary-panel__bar summary-panel__bar--${view}`}>
        {/* Its own lamp class, not `.node-light`: the panel must not compete with the
            card's four-state light for that selector (a `.card--formula .node-light`
            lookup would then describe the panel instead of the node). The colours are
            shared through the --state-* tokens in styles.css. */}
        <span className={`summary-panel__lamp summary-panel__lamp--${view}`} aria-hidden />
        <span className="summary-panel__label">{t('summary.title')}</span>
        <span className="summary-panel__status" role="status">
          {statusText}
        </span>
        <span className="summary-panel__actions">
          {view === 'done' && result ? (
            <button type="button" className="card__control summary-panel__export" onClick={download}>
              {t('summary.export')}
            </button>
          ) : null}
          {view === 'computing' ? null : (
            <button
              type="button"
              className="card__control summary-panel__compute"
              disabled={!canCompute}
              title={hasSource ? undefined : t('summary.noSource')}
              onClick={() => compute(card.id)}
            >
              {view === 'notRequested' ? t('summary.compute') : t('summary.recompute')}
            </button>
          )}
          <button
            type="button"
            className="summary-panel__collapse card__control"
            aria-label={t('summary.collapse')}
            title={t('summary.collapse')}
            onClick={() => setOpen(card.id, false)}
          >
            ‹
          </button>
        </span>
      </div>

      {/* The numbers exist only in the `done` state: 待重算 renders the banner and an EMPTY
          body, never a table with zeros (the backend has already emptied the matrix). */}
      {view === 'done' && result ? (
        <div className="summary-panel__body">
          {result.stats.length === 0 || result.columns.length === 0 ? (
            <p className="summary-panel__empty">{t('summary.emptyResult')}</p>
          ) : (
            <div className="summary-panel__table-wrap">
              <table className="summary-panel__table">
                <thead>
                  <tr>
                    <th className="summary-panel__corner" scope="col">
                      {t('summary.statColumn')}
                    </th>
                    {result.columns.map((label, column) => (
                      <th key={`${column}:${label}`} scope="col" title={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.stats.map((stat, row) => (
                    <tr key={stat} className="summary-panel__row">
                      {/* Raw catalog id: row identity, deliberately not translated. */}
                      <th scope="row" className="summary-panel__stat">
                        {stat}
                      </th>
                      {result.columns.map((_, column) => (
                        <td key={column} className="summary-panel__cell">
                          {formatCell(result.rows[row]?.[column] ?? NaN)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {statPicker}
        </div>
      ) : null}

      {view === 'stale' ? (
        <div className="summary-panel__body summary-panel__body--stale">
          {/* No table, no zeros: the bar already names the cause, so the body says what the
              emptiness means and leaves the action to the button up there. */}
          <p className="summary-panel__banner">{t('summary.staleBody')}</p>
          {statPicker}
        </div>
      ) : null}

      {view === 'error' ? (
        <div className="summary-panel__body">
          <p className="summary-panel__error" role="alert">
            {error ?? t('formula.error.unknown')}
          </p>
        </div>
      ) : null}
    </section>
  );
}
