/**
 * Status bar with the transient toast — the Qt `QStatusBar::showMessage` equivalent.
 */
import { useEffect } from 'react';

import { useTranslator, useWorkspace } from '../workspaceStore.ts';

interface StatusBarProps {
  message: string;
  cardCount: number;
}

/** How long a toast stays on screen once shown. */
const TOAST_MS = 4000;

export function StatusBar({ message, cardCount }: StatusBarProps) {
  const { t } = useTranslator();
  const toast = useWorkspace((s) => s.toast);
  const clearToast = useWorkspace((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(clearToast, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, clearToast]);

  return (
    <div className="statusbar">
      <span className="statusbar__message">{toast ? toast.message : message}</span>
      <span className="statusbar__meta">{t('status.cards', { n: cardCount })}</span>
      {toast?.kind === 'error' ? <span className="statusbar__error">!</span> : null}
      <span className="statusbar__hint">{t('table.virtualHint')}</span>
    </div>
  );
}
