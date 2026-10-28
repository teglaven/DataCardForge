/**
 * Application menu bar.
 *
 * Mirrors the Qt menu structure (`File` / `View` + language) so the interaction model
 * stays familiar, with two web-side additions: workspace save/open and CSV export.
 */
import { useEffect, useRef, useState } from 'react';

import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { Locale } from '../i18n.ts';

export interface MenuActions {
  onNewTable: () => void;
  onOpenWorkspace: () => void;
  onSaveWorkspace: () => void;
  onExportCsv: () => void;
  onExportAllCharts: () => void;
  onTile: () => void;
  onCascade: () => void;
  onResetView: () => void;
  onCloseAll: () => void;
}

interface MenuBarProps extends MenuActions {
  canExport: boolean;
  hasCharts: boolean;
}

export function MenuBar({
  onNewTable,
  onOpenWorkspace,
  onSaveWorkspace,
  onExportCsv,
  onExportAllCharts,
  onTile,
  onCascade,
  onResetView,
  onCloseAll,
  canExport,
  hasCharts,
}: MenuBarProps) {
  const { t, locale } = useTranslator();
  const setLocale = useWorkspace((s) => s.setLocale);
  // The help modal is store state (the formula card's "?" opens the same dialog), so menu
  // entries only raise a request — the dialog itself is rendered once by App.
  const openHelp = useWorkspace((s) => s.openHelp);
  const [open, setOpen] = useState<'file' | 'view' | 'language' | 'help' | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click-outside / Escape closes whichever menu is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = (label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      className="menubar__item"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        onClick();
        setOpen(null);
      }}
    >
      {label}
    </button>
  );

  const menu = (
    id: 'file' | 'view' | 'language' | 'help',
    label: string,
    children: React.ReactNode,
  ) => (
    <div className="menubar__menu">
      <button
        type="button"
        className={`menubar__trigger${open === id ? ' menubar__trigger--open' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(open === id ? null : id);
        }}
      >
        {label}
      </button>
      {open === id ? (
        <div className="menubar__dropdown" onClick={(event) => event.stopPropagation()}>
          {children}
        </div>
      ) : null}
    </div>
  );

  const languages: Array<{ value: Locale; label: string }> = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ];

  return (
    <div className="menubar" ref={rootRef}>
      <span className="menubar__brand">Data Workbench</span>
      {menu(
        'file',
        t('menu.file'),
        <>
          {item(t('menu.newMatrix'), onNewTable)}
          <div className="menubar__separator" />
          {item(t('menu.openWorkspace'), onOpenWorkspace)}
          {item(t('menu.saveWorkspace'), onSaveWorkspace)}
          <div className="menubar__separator" />
          {item(t('menu.exportCsv'), onExportCsv, !canExport)}
          {item(t('menu.exportAllCharts'), onExportAllCharts, !hasCharts)}
          <div className="menubar__separator" />
          {item(t('menu.closeAll'), onCloseAll)}
        </>,
      )}
      {menu(
        'view',
        t('menu.view'),
        <>
          {item(t('menu.tile'), onTile)}
          {item(t('menu.cascade'), onCascade)}
          <div className="menubar__separator" />
          {item(t('menu.resetView'), onResetView)}
        </>,
      )}
      {menu(
        'language',
        t('menu.language'),
        <>
          {languages.map((language) => (
            <button
              key={language.value}
              type="button"
              className={`menubar__item${locale === language.value ? ' menubar__item--checked' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                setLocale(language.value);
                setOpen(null);
              }}
            >
              {language.label}
            </button>
          ))}
        </>,
      )}
      {menu(
        'help',
        t('menu.help'),
        <>
          {item(t('menu.helpFormula'), () => openHelp('functions'))}
          {item(t('menu.helpSyntax'), () => openHelp('syntax'))}
          {item(t('menu.helpExamples'), () => openHelp('examples'))}
          <div className="menubar__separator" />
          {item(t('menu.helpErrors'), () => openHelp('errors'))}
        </>,
      )}
    </div>
  );
}
