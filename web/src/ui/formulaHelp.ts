/**
 * Reference content for the formula card: column syntax, the function catalogue, examples
 * and the error meanings.
 *
 * Why this is a separate data module and not JSX inside the dialog:
 *   - **One source of truth.** The card's `?`, the Help menu and the hover tooltips all
 *     describe the same syntax; scattering the strings through three components is how
 *     the placeholder and the real grammar drift apart.
 *   - **Bilingual by construction.** Prose lives in the i18n dictionary (zh + en); only
 *     code-shaped text (signatures, example expressions) is literal here. `MessageKey`
 *     makes a missing translation a type error instead of a key printed on screen.
 *   - **Auditable against the engine.** The catalogue below is hand-written (the engine is
 *     the C++ backend; `core/expression.ts` is only its retired reference implementation),
 *     so `tests/Help.dom.test.tsx` pins it: every `FUNCTIONS` key must appear exactly once
 *     here. That test is the reason someone changing the engine sees this file in CI.
 */
import type { MessageKey } from './i18n.ts';

/** The four sections of the help dialog; also used by the store to scroll to one. */
export type HelpSection = 'syntax' | 'functions' | 'examples' | 'errors';

/** Display order of the sections, top to bottom. */
export const HELP_SECTIONS: HelpSection[] = ['syntax', 'functions', 'examples', 'errors'];

/** One function row: engine name, display signature, localised one-liner. */
export interface HelpFunctionItem {
  /** Engine identifier, exactly as `FUNCTIONS` spells it (the sanity test compares keys). */
  name: string;
  /** Code, not prose: identical in every locale, so it is literal rather than translated. */
  signature: string;
  descriptionKey: MessageKey;
}

export interface HelpFunctionGroup {
  titleKey: MessageKey;
  items: HelpFunctionItem[];
}

/**
 * The engine's built-ins, grouped the way a user thinks about them.
 *
 * Signatures state the arity the engine enforces (`FUNCTIONS`): `c` is a column expression,
 * `x`/`a`/`b` are element-wise values, and `[…]` marks an optional argument.
 */
export const HELP_FUNCTION_GROUPS: HelpFunctionGroup[] = [
  {
    titleKey: 'help.group.aggregate',
    items: [
      { name: 'SUM', signature: 'SUM(c)', descriptionKey: 'help.fn.SUM' },
      { name: 'AVG', signature: 'AVG(c)', descriptionKey: 'help.fn.AVG' },
      { name: 'MEAN', signature: 'MEAN(c)', descriptionKey: 'help.fn.MEAN' },
      { name: 'MIN', signature: 'MIN(c) / MIN(a, b, …)', descriptionKey: 'help.fn.MIN' },
      { name: 'MAX', signature: 'MAX(c) / MAX(a, b, …)', descriptionKey: 'help.fn.MAX' },
      { name: 'MEDIAN', signature: 'MEDIAN(c)', descriptionKey: 'help.fn.MEDIAN' },
      { name: 'STD', signature: 'STD(c)', descriptionKey: 'help.fn.STD' },
      { name: 'COUNT', signature: 'COUNT(c)', descriptionKey: 'help.fn.COUNT' },
      { name: 'NAN', signature: 'NAN(c)', descriptionKey: 'help.fn.NAN' },
      { name: 'VAR', signature: 'VAR(c)', descriptionKey: 'help.fn.VAR' },
      { name: 'SEM', signature: 'SEM(c)', descriptionKey: 'help.fn.SEM' },
      // QUANTILE is the one reducing function whose result is per-row (q may be a column),
      // which is why it is listed with q rather than as a lone column.
      { name: 'QUANTILE', signature: 'QUANTILE(c, q)', descriptionKey: 'help.fn.QUANTILE' },
    ],
  },
  {
    titleKey: 'help.group.math',
    items: [
      { name: 'ABS', signature: 'ABS(x)', descriptionKey: 'help.fn.ABS' },
      { name: 'SQRT', signature: 'SQRT(x)', descriptionKey: 'help.fn.SQRT' },
      { name: 'LOG', signature: 'LOG(x)', descriptionKey: 'help.fn.LOG' },
      { name: 'LN', signature: 'LN(x)', descriptionKey: 'help.fn.LN' },
      { name: 'LOG10', signature: 'LOG10(x)', descriptionKey: 'help.fn.LOG10' },
      { name: 'EXP', signature: 'EXP(x)', descriptionKey: 'help.fn.EXP' },
      { name: 'POW', signature: 'POW(a, b)', descriptionKey: 'help.fn.POW' },
      { name: 'ROUND', signature: 'ROUND(x[, n])', descriptionKey: 'help.fn.ROUND' },
      { name: 'FLOOR', signature: 'FLOOR(x)', descriptionKey: 'help.fn.FLOOR' },
      { name: 'CEIL', signature: 'CEIL(x)', descriptionKey: 'help.fn.CEIL' },
      { name: 'SIGN', signature: 'SIGN(x)', descriptionKey: 'help.fn.SIGN' },
    ],
  },
  {
    titleKey: 'help.group.signal',
    items: [
      { name: 'MOV', signature: 'MOV(c, n)', descriptionKey: 'help.fn.MOV' },
      // The engine's second argument is alpha (the new-sample weight), NOT a window size —
      // signing it `n` would teach the wrong formula.
      { name: 'EMA', signature: 'EMA(c, alpha)', descriptionKey: 'help.fn.EMA' },
    ],
  },
  {
    titleKey: 'help.group.conditional',
    items: [{ name: 'IF', signature: 'IF(cond, a, b)', descriptionKey: 'help.fn.IF' }],
  },
];

/** One row of the "how do I name a column" table. */
export interface HelpSyntaxRow {
  /** The literal form(s), kept as code in both locales. */
  form: string;
  descriptionKey: MessageKey;
}

/**
 * The reference-syntax contract, in the order a user meets it: always-available position
 * name → bare annotation → bracket quoting → multi-input qualification → full-width input.
 */
export const HELP_SYNTAX_ROWS: HelpSyntaxRow[] = [
  { form: 'Pos.1, Pos.2, …', descriptionKey: 'help.syntax.pos' },
  { form: '时间_秒, snr_dB', descriptionKey: 'help.syntax.bare' },
  { form: '[地面速度_μm/s]', descriptionKey: 'help.syntax.bracket' },
  { form: 'A.pos.1, A.[地面速度_μm/s]', descriptionKey: 'help.syntax.qualified' },
  { form: '（ ） ， × ＊ ＋ － ／ ％ 【 】 ［ ］', descriptionKey: 'help.syntax.fullwidth' },
];

/** One example expression with the intent it demonstrates. */
export interface HelpExample {
  code: string;
  descriptionKey: MessageKey;
}

/** Copied verbatim from the formula-card review; each one earns its place. */
export const HELP_EXAMPLES: HelpExample[] = [
  { code: 'Pos.1 * 2', descriptionKey: 'help.example.scale' },
  { code: 'Pos.1 / 1000', descriptionKey: 'help.example.unit' },
  { code: '(Pos.2 - AVG(Pos.2)) / STD(Pos.2)', descriptionKey: 'help.example.zscore' },
  { code: 'MOV(Pos.2, 5)', descriptionKey: 'help.example.smooth' },
  { code: '[地面速度_μm/s] * 2', descriptionKey: 'help.example.bracket' },
  { code: 'IF(Pos.4 > 0, Pos.4, 0)', descriptionKey: 'help.example.positive' },
];

/** One error code and what the user should do about it. */
export interface HelpErrorRow {
  /** The backend's structured code, shown verbatim so it matches the card's message. */
  code: string;
  descriptionKey: MessageKey;
}

/**
 * The errors a user actually hits, each paired with the fix.
 *
 * The card itself renders the backend's localised message (`formula.error.*`); these rows
 * explain the *cause*, which the one-line alert has no room for — `unexpectedChar` in
 * particular almost always means "your column name has a `/` in it".
 */
export const HELP_ERROR_ROWS: HelpErrorRow[] = [
  { code: 'unexpectedChar', descriptionKey: 'help.error.unexpectedChar' },
  { code: 'unknownColumn', descriptionKey: 'help.error.unknownColumn' },
  { code: 'unknownFunction', descriptionKey: 'help.error.unknownFunction' },
  { code: 'badArgCount', descriptionKey: 'help.error.badArgCount' },
  // `expectedClose` and `expectedCloseAfterArgs` are the same mistake at two positions.
  { code: 'expectedClose / expectedCloseAfterArgs', descriptionKey: 'help.error.expectedClose' },
  { code: 'columnContractViolation', descriptionKey: 'help.error.columnContractViolation' },
];

/** Every documented engine function name, flat — what the catalogue test diffs. */
export const HELP_FUNCTION_NAMES: string[] = HELP_FUNCTION_GROUPS.flatMap((group) =>
  group.items.map((item) => item.name),
);
