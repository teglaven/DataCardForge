/**
 * Application root.
 *
 * Owns the cross-cutting concerns that do not belong in a card: the menu actions,
 * file ingestion (picker + drag & drop), CSV export, workspace persistence, and the
 * status line. Card geometry and dependencies live in the workspace store.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { invalidateLayout } from './cardMetrics.ts';
import { createTranslator } from './i18n.ts';
import {
  downloadText,
  matrixToCsv,
  parseFiles,
  pickFiles,
  readWorkspace,
} from './fileActions.ts';
import { exportChart } from '../charts/export.ts';
import { isChartCard, isMatrixCard } from './types.ts';
import { useWorkspace } from './workspaceStore.ts';
import { CardCanvas } from './components/CardCanvas.tsx';
import { MenuBar } from './components/MenuBar.tsx';
import { StatusBar } from './components/StatusBar.tsx';

const WORKSPACE_ACCEPT = '.json,application/json';

export default function App() {
  const cards = useWorkspace((s) => s.cards);
  const matrices = useWorkspace((s) => s.matrices);
  const locale = useWorkspace((s) => s.locale);
  const addMatrixCard = useWorkspace((s) => s.addMatrixCard);
  const showToast = useWorkspace((s) => s.showToast);
  const tileCards = useWorkspace((s) => s.tileCards);
  const cascadeCards = useWorkspace((s) => s.cascadeCards);
  const closeAllCards = useWorkspace((s) => s.closeAllCards);
  const toSnapshot = useWorkspace((s) => s.toSnapshot);
  const loadSnapshot = useWorkspace((s) => s.loadSnapshot);

  const t = createTranslator(locale);

  const [status, setStatus] = useState(() => t('status.ready'));
  const shellRef = useRef<HTMLDivElement | null>(null);

  // Keep the status line in the active language until a new message replaces it.
  useEffect(() => {
    setStatus(t('status.ready'));
  }, [locale]); // eslint-disable-line react-hooks/exhaustive-deps

  // The first card needs real canvas dimensions, which are only known after mount.
  useEffect(() => {
    const measure = () => {
      const node = shellRef.current;
      if (node) invalidateLayout();
    };
    const observer = new ResizeObserver(measure);
    if (shellRef.current) observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, []);

  /** Parse dropped / picked files and open them as one multi-file matrix card. */
  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const { loaded, failures } = await parseFiles(files);

      for (const failure of failures) {
        showToast('error', t('dialog.loadFailedBody', { name: failure.name, error: failure.error }));
      }

      if (loaded.length === 0) return;

      addMatrixCard(loaded);

      if (loaded.length === 1) {
        const only = loaded[0];
        setStatus(
          t('status.loaded', {
            name: only.name,
            rows: only.matrix.rowCount(),
            cols: only.matrix.columnCount(),
          }),
        );
      } else {
        setStatus(t('status.loadedMany', { count: loaded.length }));
      }
      invalidateLayout();
    },
    [addMatrixCard, showToast, t],
  );

  const onNewTable = useCallback(async () => {
    const files = await pickFiles(true);
    await ingestFiles(files);
  }, [ingestFiles]);

  const onSaveWorkspace = useCallback(() => {
    try {
      const snapshot = toSnapshot();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadText(`data-workbench-${stamp}.json`, JSON.stringify(snapshot), 'application/json');
      setStatus(t('status.exported', { name: `data-workbench-${stamp}.json` }));
    } catch (error) {
      showToast('error', t('status.saveFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [toSnapshot, showToast, t]);

  const onOpenWorkspace = useCallback(async () => {
    const files = await pickFiles(false, WORKSPACE_ACCEPT);
    if (files.length === 0) return;
    try {
      const snapshot = await readWorkspace(files[0]);
      loadSnapshot(snapshot);
      setStatus(t('status.loaded', {
        name: files[0].name,
        rows: snapshot.matrices.length,
        cols: snapshot.cards.length,
      }));
      invalidateLayout();
    } catch (error) {
      showToast('error', t('dialog.openWorkspaceFailed'));
      void error;
    }
  }, [loadSnapshot, showToast, t]);

  /** Export the currently displayed matrix of the selected (or first) matrix card. */
  const onExportCsv = useCallback(() => {
    const state = useWorkspace.getState();
    const selected = state.cards.find((c) => c.id === state.selectedId);
    const card =
      selected && isMatrixCard(selected) ? selected : state.cards.find(isMatrixCard);
    if (!card || !isMatrixCard(card)) return;

    const source = card.sources[card.activeSource];
    const matrix = source ? state.matrices.get(source.matrixId) : undefined;
    if (!source || !matrix) return;

    const base = source.name.replace(/\.[^.]+$/, '');
    downloadText(`${base}.csv`, matrixToCsv(matrix), 'text/csv;charset=utf-8');
    setStatus(t('status.exported', { name: `${base}.csv` }));
  }, [t]);

  /** Export every chart card as an SVG file. */
  const onExportAllCharts = useCallback(async () => {
    const state = useWorkspace.getState();
    const chartCards = state.cards.filter(isChartCard);
    if (chartCards.length === 0) return;

    // We need the DOM containers to extract SVG. Query them by card id.
    let exported = 0;
    for (const card of chartCards) {
      const container = document.querySelector(
        `.card--chart[data-card-id="${card.id}"] .chart-card__plot`,
      ) as HTMLElement | null;
      if (!container) continue;
      try {
        const label = card.config.sources[0]?.label ?? `chart-${card.id}`;
        const safeName = `data-workbench-${card.config.type}-${label}`.replace(
          /[^\w.-]+/g, '_',
        );
        await exportChart(container, 'svg', {
          name: safeName,
          pixelRatio: 2,
          background: '#ffffff',
        });
        exported++;
      } catch {
        // Skip cards that fail to export; continue with the rest.
      }
    }

    if (exported > 0) {
      showToast('info', t('status.exported', { name: `${exported} SVG(s)` }));
    }
  }, [showToast, t]);

  /**
   * Tile / cascade need the live canvas size, not the window size, and must re-measure
   * connection anchors once the DOM has applied the new geometry.
   */
  const canvasSize = () => {
    const rect = shellRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? window.innerWidth, height: rect?.height ?? window.innerHeight };
  };

  const afterBulkLayoutChange = () => {
    requestAnimationFrame(() => invalidateLayout());
  };

  const onTile = useCallback(() => {
    const { width, height } = canvasSize();
    tileCards(width, height);
    afterBulkLayoutChange();
  }, [tileCards]);

  const onCascade = useCallback(() => {
    cascadeCards();
    afterBulkLayoutChange();
  }, [cascadeCards]);

  const onCloseAll = useCallback(() => {
    closeAllCards();
    setStatus(t('status.ready'));
  }, [closeAllCards, t]);

  const onCanvasContextMenu = useCallback(
    (event: React.MouseEvent) => {
      // Only the bare canvas offers the gesture; cards handle their own menus.
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      void onNewTable();
    },
    [onNewTable],
  );

  const exportable = cards.some(isMatrixCard) && matrices.size > 0;
  const hasCharts = cards.some(isChartCard);

  return (
    <div className="app" ref={shellRef}>
      <MenuBar
        onNewTable={() => void onNewTable()}
        onOpenWorkspace={() => void onOpenWorkspace()}
        onSaveWorkspace={onSaveWorkspace}
        onExportCsv={onExportCsv}
        onExportAllCharts={() => void onExportAllCharts()}
        canExport={exportable}
        hasCharts={hasCharts}
        onTile={onTile}
        onCascade={onCascade}
        onCloseAll={onCloseAll}
      />
      <CardCanvas
        onNewTable={() => void onNewTable()}
        onFilesDropped={(files: File[]) => void ingestFiles(files)}
        onContextMenu={onCanvasContextMenu}
      />
      <StatusBar message={status} cardCount={cards.length} />
    </div>
  );
}
