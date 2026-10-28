/**
 * Help dialog: the formula card's reference manual, as a viewport modal.
 *
 * Why a portal (`createPortal(…, document.body)`) rather than a panel inside the card:
 * the cards are transform-positioned and clipped — `position: fixed` inside a transformed
 * ancestor is positioned against the CARD, and `.card { overflow: hidden }` cuts it off.
 * The same reasoning that produced `Popup.tsx` applies with more force to a full-page
 * modal (a modal *inside* a card would be clipped to a ~300px window).
 *
 * The open state lives in the workspace store, not in props: the dialog is reachable from
 * the top-left Help menu and from the card's `?` button, and `CardCanvas` — the component
 * that would otherwise have to relay a prop — is not allowed to grow a coincidence
 * parameter for it (docs/decisions: the canvas knows about cards, not about toolbars).
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import {
  HELP_ERROR_ROWS,
  HELP_EXAMPLES,
  HELP_FUNCTION_GROUPS,
  HELP_SYNTAX_ROWS,
  type HelpSection,
} from '../formulaHelp.ts';

const SECTION_TITLE_KEY = {
  syntax: 'help.section.syntax',
  functions: 'help.section.functions',
  examples: 'help.section.examples',
  errors: 'help.section.errors',
} as const;

export function HelpDialog() {
  const { t } = useTranslator();
  const open = useWorkspace((s) => s.helpOpen);
  const requested = useWorkspace((s) => s.helpSection);
  const closeHelp = useWorkspace((s) => s.closeHelp);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Escape closes it — the one keyboard gesture every web modal is expected to honour.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeHelp]);

  // Opening from "常见报错" must land on that section, not on the top of a long page.
  // `scrollIntoView` is missing in jsdom, so the call is optional on purpose.
  useEffect(() => {
    if (!open || !requested) return;
    const section = bodyRef.current?.querySelector<HTMLElement>(
      `[data-section="${requested}"]`,
    );
    section?.scrollIntoView?.({ block: 'start' });
  }, [open, requested]);

  // Move focus into the dialog so Tab does not walk the page behind it.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const section = (id: HelpSection, children: React.ReactNode) => (
    <section
      className={`help-dialog__section${requested === id ? ' help-dialog__section--target' : ''}`}
      data-section={id}
      aria-labelledby={`help-title-${id}`}
    >
      <h3 className="help-dialog__heading" id={`help-title-${id}`}>
        {t(SECTION_TITLE_KEY[id])}
      </h3>
      {children}
    </section>
  );

  return createPortal(
    <div
      className="help-dialog__backdrop"
      // A click on the backdrop (not inside the panel) closes: the usual way out of a
      // read-only overlay. `event.target === event.currentTarget` keeps clicks inside
      // the panel from bubbling out as a close.
      onClick={(event) => {
        if (event.target === event.currentTarget) closeHelp();
      }}
    >
      <div
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
      >
        <header className="help-dialog__head">
          <h2 className="help-dialog__title" id="help-dialog-title">
            {t('help.title')}
          </h2>
          <button
            type="button"
            ref={closeRef}
            className="help-dialog__close card__control"
            aria-label={t('help.close')}
            onClick={closeHelp}
          >
            ×
          </button>
        </header>

        <div className="help-dialog__body" ref={bodyRef}>
          {section(
            'syntax',
            <table className="help-dialog__table">
              <thead>
                <tr>
                  <th scope="col">{t('help.syntax.form')}</th>
                  <th scope="col">{t('help.syntax.meaning')}</th>
                </tr>
              </thead>
              <tbody>
                {HELP_SYNTAX_ROWS.map((row) => (
                  <tr key={row.form}>
                    <td>
                      <code>{row.form}</code>
                    </td>
                    <td>{t(row.descriptionKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>,
          )}

          {section(
            'functions',
            <>
              <p className="help-dialog__note">{t('help.functions.note')}</p>
              {HELP_FUNCTION_GROUPS.map((group) => (
                <div className="help-dialog__group" key={group.titleKey}>
                  <h4 className="help-dialog__group-title">{t(group.titleKey)}</h4>
                  <dl className="help-dialog__fn-list">
                    {group.items.map((item) => (
                      <div className="help-dialog__fn" key={item.name}>
                        <dt>
                          <code>{item.signature}</code>
                        </dt>
                        <dd>{t(item.descriptionKey)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </>,
          )}

          {section(
            'examples',
            <ul className="help-dialog__examples">
              {HELP_EXAMPLES.map((example) => (
                <li key={example.code} className="help-dialog__example">
                  <code>{example.code}</code>
                  <span className="help-dialog__example-note">{t(example.descriptionKey)}</span>
                </li>
              ))}
            </ul>,
          )}

          {section(
            'errors',
            <dl className="help-dialog__fn-list">
              {HELP_ERROR_ROWS.map((row) => (
                <div className="help-dialog__fn" key={row.code}>
                  <dt>
                    <code>{row.code}</code>
                  </dt>
                  <dd>{t(row.descriptionKey)}</dd>
                </div>
              ))}
            </dl>,
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
