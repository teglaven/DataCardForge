/**
 * Column expression engine.
 *
 * ⚠️ **已退出生产路径，仅作 xlayer 差分基准。** Under the B-plan
 * (docs/decisions/2026-10-17-backend-owns-compute.md) the parse / compile / evaluate of
 * formulas all live in the C++ backend; the browser ships formula *text* only. Nothing on a
 * production code path imports this file any more — it is kept solely as the reference
 * implementation the cross-layer fixtures (`tests/fixtures/xlayer/*.json`) diff the C++
 * engine against, and will be retired once that differential coverage is complete.
 * Do NOT wire it back into UI or store compute.
 *
 * Evaluates formulas like `(A - B) / C`, `MOV(A, 5)`, `IF(A > 0, A, 0)` against a
 * column-oriented matrix. Every operation is vectorised over the full column length,
 * so a 10 000-row expression runs in one pass without per-cell overhead.
 *
 * Design constraints:
 *   - **No dependencies.** The tokenizer and shunting-yard parser are ~200 lines of
 *     hand-written code — small enough to audit, fast enough to evaluate interactively.
 *   - **Column references by name.** `Pos.1`, `Pos.2`, or the annotation (`temp`) can be
 *     used as variable names. The resolver maps them to column indices at parse time.
 *   - **NaN propagation.** Any operation on NaN produces NaN (IEEE 754 default), which
 *     the UI already renders as `—`. No special handling needed.
 *   - **Pure functions.** `compile()` returns an evaluator closure; calling it with a
 *     matrix produces a `number[]` result. No side effects, no DOM, fully testable.
 */

// ── Token types ────────────────────────────────────────────────────────

type TokenType =
  | 'number'
  | 'ident'      // column name or function name
  | 'op'         // + - * / ^ %
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'compare'    // > < >= <= == !=
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
  /** `[名字]` produced this token: always a column reference, never a function call. */
  quoted?: boolean;
}

// ── Tokenizer ──────────────────────────────────────────────────────────

const OPERATORS = new Set(['+', '-', '*', '/', '^', '%']);
const COMPARES = ['>=', '<=', '==', '!=', '>', '<'];

/**
 * Full-width punctuation a Chinese IME produces, and the ASCII operator it stands for.
 *
 * Mirrored verbatim in `backend/src/expression.cpp` — the two engines must classify every
 * character the same way or the differential fixtures fail. Mapping is applied per token
 * rather than by rewriting the input, so a bracketed name that legitimately contains a
 * full-width glyph (`[温度（℃）]`) keeps it verbatim.
 */
const FULL_WIDTH: Record<string, string> = {
  '（': '(', '）': ')', '，': ',', '、': ',', '＋': '+', '－': '-', '−': '-',
  '＊': '*', '×': '*', '／': '/', '÷': '/', '％': '%', '＾': '^', '＝': '=',
  '＞': '>', '＜': '<', '≠': '!=', '　': ' ',
};

const OPEN_BRACKETS = ['[', '［', '【'];
const CLOSE_BRACKETS = [']', '］', '】'];

function fullWidthAt(input: string, i: number): string | null {
  const ch = input[i];
  return Object.prototype.hasOwnProperty.call(FULL_WIDTH, ch) ? FULL_WIDTH[ch] : null;
}

function isBracketOpenAt(input: string, i: number): boolean {
  return OPEN_BRACKETS.includes(input[i]);
}

function trimName(name: string): string {
  return name.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

/**
 * Read a bracketed column name starting at the opener.
 *
 * The content is data, not grammar — that is what makes `[地面速度_μm/s]`, `[温度（℃）]`
 * addressable at all.
 */
function scanBracket(
  input: string,
  i: number,
): { inner: string; next: number; openPos: number } | null {
  if (!isBracketOpenAt(input, i)) return null;
  const openPos = i;
  let j = i + 1;
  while (j < input.length) {
    if (CLOSE_BRACKETS.includes(input[j])) {
      return { inner: input.slice(i + 1, j), next: j + 1, openPos };
    }
    j++;
  }
  return null;
}

/** Any non-ASCII character is a name character (CJK / μ / ° annotations). */
function isNonAscii(ch: string): boolean {
  return ch.length > 0 && ch.charCodeAt(0) >= 0x80;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Skip whitespace (\s already covers U+3000).
    if (/\s/.test(ch)) { i++; continue; }

    // Number literal: digits, optional dot, optional exponent.
    if (/\d/.test(ch) || (ch === '.' && i + 1 < input.length && /\d/.test(input[i + 1]))) {
      const start = i;
      while (i < input.length && /[\d.]/.test(input[i])) i++;
      if (i < input.length && /[eE]/.test(input[i])) {
        i++;
        if (i < input.length && /[+-]/.test(input[i])) i++;
        while (i < input.length && /\d/.test(input[i])) i++;
      }
      tokens.push({ type: 'number', value: input.slice(start, i), pos: start });
      continue;
    }

    // Bracket-quoted column name: `[地面速度_μm/s]`. The content is data, not grammar.
    if (isBracketOpenAt(input, i)) {
      const scanned = scanBracket(input, i);
      if (!scanned) {
        throw new ExpressionError(
          `Expected ']' to close the column name`,
          i,
          'expectedClose',
          { name: '[' },
        );
      }
      tokens.push({ type: 'ident', value: trimName(scanned.inner), pos: i, quoted: true });
      i = scanned.next;
      continue;
    }

    // Full-width punctuation stands in for its ASCII operator (（） ， × ／ － …). This has
    // to be classified before the identifier rule, because every full-width glyph is also
    // a non-ASCII byte and would otherwise be swallowed into a name.
    {
      const ascii = fullWidthAt(input, i);
      if (ascii !== null) {
        const pos = i;
        if (ascii === '(') tokens.push({ type: 'lparen', value: '(', pos });
        else if (ascii === ')') tokens.push({ type: 'rparen', value: ')', pos });
        else if (ascii === ',') tokens.push({ type: 'comma', value: ',', pos });
        else if (ascii === '>' || ascii === '<' || ascii === '!=') {
          tokens.push({ type: 'compare', value: ascii, pos });
        } else if (ascii.length === 1 && OPERATORS.has(ascii)) {
          tokens.push({ type: 'op', value: ascii, pos });
        } else {
          throw new ExpressionError(
            `Unexpected character '${ch}' at position ${pos}`,
            pos,
            'unexpectedChar',
            { char: ch, position: pos },
          );
        }
        i++;
        continue;
      }
    }

    // Identifier: letter, underscore, digit, dot (for Pos.N names), or any non-ASCII
    // character — an annotated column is referred to by the spelling its card advertises
    // ("时间_秒"). Structural punctuation and a bracket opener end the run.
    if (/[a-zA-Z_]/.test(ch) || isNonAscii(ch)) {
      const start = i;
      while (i < input.length) {
        const c = input[i];
        if (fullWidthAt(input, i) !== null || isBracketOpenAt(input, i)) break;
        if (!/[a-zA-Z0-9_.]/.test(c) && !isNonAscii(c)) break;
        i++;
      }
      let ident = input.slice(start, i);
      // Hard stop against a stall: a branch that consumes nothing must never spin.
      if (ident === '') {
        throw new ExpressionError(
          `Unexpected character '${ch}' at position ${i}`,
          i,
          'unexpectedChar',
          { char: ch, position: i },
        );
      }
      // `A.[名字]` / `src.[名字]`: the alias prefix and the quoted column are one name.
      if (i < input.length && isBracketOpenAt(input, i) && ident.endsWith('.')) {
        ident = ident.slice(0, -1);
        const scanned = scanBracket(input, i);
        if (!scanned) {
          throw new ExpressionError(
            `Expected ']' to close the column name`,
            i,
            'expectedClose',
            { name: '[' },
          );
        }
        tokens.push({
          type: 'ident',
          value: `${ident}.${trimName(scanned.inner)}`,
          pos: start,
          quoted: true,
        });
        i = scanned.next;
        continue;
      }
      tokens.push({ type: 'ident', value: ident, pos: start });
      continue;
    }

    // Comparison operators (two-char first).
    const twoChar = input.slice(i, i + 2);
    if (COMPARES.includes(twoChar)) {
      tokens.push({ type: 'compare', value: twoChar, pos: i });
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<') {
      tokens.push({ type: 'compare', value: ch, pos: i });
      i++;
      continue;
    }

    // Single-char operators and punctuation.
    if (OPERATORS.has(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(', pos: i }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')', pos: i }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',', pos: i }); i++; continue; }

    throw new ExpressionError(`Unexpected character '${ch}' at position ${i}`, i, 'unexpectedChar', {
      char: ch,
      position: i,
    });
  }

  tokens.push({ type: 'eof', value: '', pos: i });
  return tokens;
}

// ── AST nodes ──────────────────────────────────────────────────────────

type ASTNode =
  | { kind: 'number'; value: number }
  | { kind: 'column'; index: number; name: string }
  | { kind: 'binary'; op: string; left: ASTNode; right: ASTNode }
  | { kind: 'unary'; op: string; operand: ASTNode }
  | { kind: 'call'; name: string; args: ASTNode[] };

// ── Shunting-yard parser ───────────────────────────────────────────────

const PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3, '>': 3, '<': 3, '>=': 3, '<=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
  '^': 6,
};

const RIGHT_ASSOC = new Set(['^']);

/** Built-in functions and their minimum/maximum argument counts. */
export const FUNCTIONS: Record<string, { minArgs: number; maxArgs: number }> = {
  // Aggregations (reduce a column to a scalar, then broadcast).
  SUM: { minArgs: 1, maxArgs: 1 },
  AVG: { minArgs: 1, maxArgs: 1 },
  MEAN: { minArgs: 1, maxArgs: 1 },
  MIN: { minArgs: 1, maxArgs: Infinity },
  MAX: { minArgs: 1, maxArgs: Infinity },
  MEDIAN: { minArgs: 1, maxArgs: 1 },
  STD: { minArgs: 1, maxArgs: 1 },
  // Summary statistics (added for builtin:summary). COUNT/NAN/VAR/SEM reduce like the
  // aggregations above; QUANTILE takes a second argument (the quantile, constant or
  // column) and is therefore per-row — see its own branch below.
  COUNT: { minArgs: 1, maxArgs: 1 },
  NAN: { minArgs: 1, maxArgs: 1 },
  VAR: { minArgs: 1, maxArgs: 1 },
  SEM: { minArgs: 1, maxArgs: 1 },
  QUANTILE: { minArgs: 2, maxArgs: 2 },
  // Element-wise math.
  ABS: { minArgs: 1, maxArgs: 1 },
  SQRT: { minArgs: 1, maxArgs: 1 },
  LOG: { minArgs: 1, maxArgs: 1 },
  LN: { minArgs: 1, maxArgs: 1 },
  LOG10: { minArgs: 1, maxArgs: 1 },
  EXP: { minArgs: 1, maxArgs: 1 },
  POW: { minArgs: 2, maxArgs: 2 },
  ROUND: { minArgs: 1, maxArgs: 2 },
  FLOOR: { minArgs: 1, maxArgs: 1 },
  CEIL: { minArgs: 1, maxArgs: 1 },
  SIGN: { minArgs: 1, maxArgs: 1 },
  // Moving window.
  MOV: { minArgs: 2, maxArgs: 2 },       // MOV(column, window)
  EMA: { minArgs: 2, maxArgs: 2 },       // EMA(column, alpha)
  // Conditional.
  IF: { minArgs: 3, maxArgs: 3 },        // IF(cond, trueVal, falseVal)
};

/**
 * Aggregation functions that reduce a column to a scalar.
 *
 * QUANTILE is deliberately NOT here: it is the one aggregation whose result is per-row
 * (its q may be a column), so it cannot share the "reduce once, broadcast" branch.
 */
const AGGREGATIONS = new Set(['SUM', 'AVG', 'MEAN', 'MIN', 'MAX', 'MEDIAN', 'STD', 'COUNT', 'NAN', 'VAR', 'SEM']);

/**
 * Machine-readable reason for an expression failure.
 *
 * The English `message` stays for logs, tests and stack traces; the UI renders a localised
 * sentence from `code` + `params` so a Chinese-language user never sees a raw parser
 * message.
 */
export type ExpressionErrorCode =
  | 'unexpectedChar'
  | 'unknownFunction'
  | 'expectedCloseAfterArgs'
  | 'badArgCount'
  | 'unknownColumn'
  | 'expectedClose'
  | 'unexpectedToken'
  | 'trailingToken';

export class ExpressionError extends Error {
  constructor(
    message: string,
    public readonly position: number,
    public readonly code: ExpressionErrorCode = 'unexpectedToken',
    public readonly params: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

interface CompileContext {
  /** Map from column name (case-insensitive) to column index. */
  columns: Map<string, number>;
}

function parse(tokens: Token[], ctx: CompileContext): ASTNode {
  let pos = 0;

  function peek(): Token { return tokens[pos]; }
  function advance(): Token { return tokens[pos++]; }

  function parseExpression(minPrec = 0): ASTNode {
    let left = parseUnary();

    while (true) {
      const token = peek();
      const op = token.type === 'op' ? token.value : token.type === 'compare' ? token.value : null;
      if (!op || !(op in PRECEDENCE)) break;

      const prec = PRECEDENCE[op];
      if (prec < minPrec) break;

      advance();
      const nextMinPrec = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = parseExpression(nextMinPrec);
      left = { kind: 'binary', op, left, right };
    }

    return left;
  }

  function parseUnary(): ASTNode {
    const token = peek();
    if (token.type === 'op' && (token.value === '-' || token.value === '+')) {
      advance();
      const operand = parseUnary();
      if (token.value === '+') return operand;
      return { kind: 'unary', op: '-', operand };
    }
    return parsePrimary();
  }

  function parsePrimary(): ASTNode {
    const token = peek();

    if (token.type === 'number') {
      advance();
      return { kind: 'number', value: parseFloat(token.value) };
    }

    if (token.type === 'ident') {
      advance();
      const name = token.value;

      // Function call? Not for a bracketed name — `[SUM](…)` is a column named SUM.
      if (!token.quoted && peek().type === 'lparen') {
        const upper = name.toUpperCase();
        if (!(upper in FUNCTIONS)) {
          throw new ExpressionError(`Unknown function '${name}'`, token.pos, 'unknownFunction', {
            name,
          });
        }
        advance(); // consume '('
        const args: ASTNode[] = [];
        if (peek().type !== 'rparen') {
          args.push(parseExpression());
          while (peek().type === 'comma') {
            advance();
            args.push(parseExpression());
          }
        }
        if (peek().type !== 'rparen') {
          throw new ExpressionError(
            `Expected ')' after function arguments`,
            peek().pos,
            'expectedCloseAfterArgs',
          );
        }
        advance(); // consume ')'

        const spec = FUNCTIONS[upper];
        if (args.length < spec.minArgs || args.length > spec.maxArgs) {
          throw new ExpressionError(
            `${name}() expects ${spec.minArgs}${spec.maxArgs === Infinity ? '+' : `–${spec.maxArgs}`} argument(s), got ${args.length}`,
            token.pos,
            'badArgCount',
            {
              name,
              min: spec.minArgs,
              max: spec.maxArgs === Infinity ? '∞' : spec.maxArgs,
              got: args.length,
            },
          );
        }
        return { kind: 'call', name: upper, args };
      }

      // Column reference.
      const lower = name.toLowerCase();
      const index = ctx.columns.get(lower);
      if (index === undefined) {
        throw new ExpressionError(`Unknown column '${name}'`, token.pos, 'unknownColumn', {
          name,
        });
      }
      return { kind: 'column', index, name };
    }

    if (token.type === 'lparen') {
      advance();
      const expr = parseExpression();
      if (peek().type !== 'rparen') {
        throw new ExpressionError(`Expected ')'`, peek().pos, 'expectedClose');
      }
      advance();
      return expr;
    }

    throw new ExpressionError(
      `Unexpected token '${token.value || token.type}'`,
      token.pos,
      'unexpectedToken',
      { token: token.value || token.type },
    );
  }

  const ast = parseExpression();
  if (peek().type !== 'eof') {
    throw new ExpressionError(
      `Unexpected token '${peek().value}' after expression`,
      peek().pos,
      'trailingToken',
      { token: peek().value },
    );
  }
  return ast;
}

// ── Evaluator ──────────────────────────────────────────────────────────

/**
 * A compiled expression: a function that takes column data arrays and returns the
 * result column. Each array has `length` elements (the row count).
 */
export type Evaluator = (columns: number[][], length: number) => number[];

function compileAST(node: ASTNode): Evaluator {
  switch (node.kind) {
    case 'number': {
      const v = node.value;
      return (_cols, len) => new Array<number>(len).fill(v);
    }

    case 'column': {
      const idx = node.index;
      return (cols) => cols[idx];
    }

    case 'unary': {
      const inner = compileAST(node.operand);
      return (cols, len) => {
        const v = inner(cols, len);
        const out = new Array<number>(len);
        for (let i = 0; i < len; i++) out[i] = -v[i];
        return out;
      };
    }

    case 'binary': {
      const left = compileAST(node.left);
      const right = compileAST(node.right);
      const op = node.op;
      return (cols, len) => {
        const l = left(cols, len);
        const r = right(cols, len);
        const out = new Array<number>(len);
        for (let i = 0; i < len; i++) {
          switch (op) {
            case '+': out[i] = l[i] + r[i]; break;
            case '-': out[i] = l[i] - r[i]; break;
            case '*': out[i] = l[i] * r[i]; break;
            case '/': out[i] = l[i] / r[i]; break;
            case '%': out[i] = l[i] % r[i]; break;
            case '^': out[i] = Math.pow(l[i], r[i]); break;
            case '>': out[i] = l[i] > r[i] ? 1 : 0; break;
            case '<': out[i] = l[i] < r[i] ? 1 : 0; break;
            case '>=': out[i] = l[i] >= r[i] ? 1 : 0; break;
            case '<=': out[i] = l[i] <= r[i] ? 1 : 0; break;
            case '==': out[i] = l[i] === r[i] ? 1 : 0; break;
            case '!=': out[i] = l[i] !== r[i] ? 1 : 0; break;
            default: out[i] = NaN;
          }
        }
        return out;
      };
    }

    case 'call': {
      const argFns = node.args.map(compileAST);
      const name = node.name;

      // Aggregations: reduce to scalar, broadcast.
      // MIN/MAX with multiple args are element-wise (handled below), so skip aggregation.
      if (AGGREGATIONS.has(name) && !(argFns.length > 1 && (name === 'MIN' || name === 'MAX'))) {
        const inner = argFns[0];
        return (cols, len) => {
          const v = inner(cols, len);
          let scalar: number;
          switch (name) {
            case 'SUM': {
              let s = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) s += v[i];
              scalar = s;
              break;
            }
            case 'AVG':
            case 'MEAN': {
              let s = 0; let n = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) { s += v[i]; n++; }
              scalar = n > 0 ? s / n : NaN;
              break;
            }
            case 'MIN': {
              let m = Infinity;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i]) && v[i] < m) m = v[i];
              scalar = m === Infinity ? NaN : m;
              break;
            }
            case 'MAX': {
              let m = -Infinity;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i]) && v[i] > m) m = v[i];
              scalar = m === -Infinity ? NaN : m;
              break;
            }
            case 'MEDIAN': {
              const sorted = v.filter(Number.isFinite).sort((a, b) => a - b);
              const mid = Math.floor(sorted.length / 2);
              scalar = sorted.length === 0 ? NaN
                : sorted.length % 2 ? sorted[mid]
                : (sorted[mid - 1] + sorted[mid]) / 2;
              break;
            }
            case 'STD': {
              let s = 0; let n = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) { s += v[i]; n++; }
              const mean = n > 0 ? s / n : NaN;
              let ss = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) ss += (v[i] - mean) ** 2;
              // n = 0 has no spread to report → NaN (undefined), never 0. Only n = 1 is
              // "0 by convention". Matches stats.ts (variance(n=0) = NaN ⇒ stdDev = NaN)
              // and the summary catalog's `sd` row.
              scalar = n > 1 ? Math.sqrt(ss / (n - 1)) : n === 1 ? 0 : NaN;
              break;
            }
            case 'COUNT': {
              // Finite values only: NaN and ±Infinity are not observations.
              let c = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) c++;
              scalar = c;
              break;
            }
            case 'NAN': {
              // Deliberately narrower than "non-finite": NaN ONLY (±Infinity is a
              // different defect and is not folded into this number).
              let c = 0;
              for (let i = 0; i < len; i++) if (Number.isNaN(v[i])) c++;
              scalar = c;
              break;
            }
            case 'VAR': {
              // Sample variance, the primitive stats.ts variance() uses (ddof = n-1).
              let s = 0; let n = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) { s += v[i]; n++; }
              if (n === 0) { scalar = NaN; break; }
              if (n === 1) { scalar = 0; break; }
              const mean = s / n;
              let ss = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) ss += (v[i] - mean) ** 2;
              scalar = ss / (n - 1);
              break;
            }
            case 'SEM': {
              // sd / sqrt(n); fewer than two observations cannot estimate it → 0.
              let s = 0; let n = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) { s += v[i]; n++; }
              if (n < 2) { scalar = 0; break; }
              const mean = s / n;
              let ss = 0;
              for (let i = 0; i < len; i++) if (Number.isFinite(v[i])) ss += (v[i] - mean) ** 2;
              scalar = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
              break;
            }
            default:
              scalar = NaN;
          }
          return new Array<number>(len).fill(scalar);
        };
      }

      // QUANTILE(col, q) — R-7 (linear interpolation between closest ranks), the exact
      // definition stats.ts:quantile() implements. NOT a scalar-broadcast aggregation: q
      // may be a column, so the result is per-row. Out-of-range q clamps to [0,1] like the
      // reference; a non-finite q yields NaN explicitly (stats.ts would compute
      // data[NaN] === undefined — the guard is deliberate and is pinned by the fixtures).
      if (name === 'QUANTILE') {
        const valuesFn = argFns[0];
        const quantileFn = argFns[1];
        return (cols: number[][], len: number) => {
          const values = valuesFn(cols, len);
          const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
          const quantiles = quantileFn(cols, len);
          const out = new Array<number>(len);
          for (let i = 0; i < len; i++) {
            const q = quantiles[i];
            if (!Number.isFinite(q) || sorted.length === 0) {
              out[i] = NaN;
              continue;
            }
            const clamped = Math.min(1, Math.max(0, q));
            if (sorted.length === 1) {
              out[i] = sorted[0];
              continue;
            }
            const position = (sorted.length - 1) * clamped;
            const lower = Math.floor(position);
            const upper = Math.ceil(position);
            if (lower === upper) {
              out[i] = sorted[lower];
              continue;
            }
            const fraction = position - lower;
            out[i] = sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
          }
          return out;
        };
      }

      // MIN/MAX with multiple args: element-wise min/max across columns.
      if ((name === 'MIN' || name === 'MAX') && argFns.length > 1) {
        return (cols, len) => {
          const arrays = argFns.map((fn) => fn(cols, len));
          const out = new Array<number>(len);
          for (let i = 0; i < len; i++) {
            let result = arrays[0][i];
            for (let a = 1; a < arrays.length; a++) {
              result = name === 'MIN' ? Math.min(result, arrays[a][i]) : Math.max(result, arrays[a][i]);
            }
            out[i] = result;
          }
          return out;
        };
      }

      // Element-wise math functions.
      const mathFns: Record<string, (...args: number[]) => number> = {
        ABS: Math.abs,
        SQRT: Math.sqrt,
        LOG: Math.log,
        LN: Math.log,
        LOG10: Math.log10,
        EXP: Math.exp,
        POW: Math.pow,
        FLOOR: Math.floor,
        CEIL: Math.ceil,
        SIGN: Math.sign,
        ROUND: (v, d = 0) => {
          const f = 10 ** d;
          return Math.round(v * f) / f;
        },
      };

      if (name in mathFns) {
        const fn = mathFns[name];
        return (cols, len) => {
          const arrays = argFns.map((f) => f(cols, len));
          const out = new Array<number>(len);
          for (let i = 0; i < len; i++) {
            const args = arrays.map((a) => a[i]);
            out[i] = fn(...args);
          }
          return out;
        };
      }

      // MOV(column, window) — moving average.
      if (name === 'MOV') {
        const dataFn = argFns[0];
        const windowFn = argFns[1];
        return (cols, len) => {
          const data = dataFn(cols, len);
          const w = Math.round(windowFn(cols, len)[0]);
          if (w <= 1) return data.slice();
          const half = Math.floor(w / 2);
          const out = new Array<number>(len);
          for (let j = 0; j < len; j++) {
            const lo = Math.max(0, j - half);
            const hi = Math.min(len, j + half + 1);
            let sum = 0;
            for (let k = lo; k < hi; k++) sum += data[k];
            out[j] = sum / (hi - lo);
          }
          return out;
        };
      }

      // EMA(column, alpha) — exponential moving average.
      if (name === 'EMA') {
        const dataFn = argFns[0];
        const alphaFn = argFns[1];
        return (cols, len) => {
          const data = dataFn(cols, len);
          const alpha = alphaFn(cols, len)[0];
          const out = new Array<number>(len);
          out[0] = data[0];
          for (let i = 1; i < len; i++) {
            out[i] = alpha * data[i] + (1 - alpha) * out[i - 1];
          }
          return out;
        };
      }

      // IF(cond, trueVal, falseVal) — element-wise conditional.
      if (name === 'IF') {
        const condFn = argFns[0];
        const trueFn = argFns[1];
        const falseFn = argFns[2];
        return (cols, len) => {
          const cond = condFn(cols, len);
          const t = trueFn(cols, len);
          const f = falseFn(cols, len);
          const out = new Array<number>(len);
          for (let i = 0; i < len; i++) {
            out[i] = cond[i] !== 0 ? t[i] : f[i];
          }
          return out;
        };
      }

      // Should not reach here.
      return () => [];
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export interface CompiledExpression {
  /** The original source text. */
  source: string;
  /** Column names referenced by the expression. */
  references: string[];
  /** Evaluate against column data arrays. */
  evaluate: Evaluator;
}

/**
 * Compile an expression string into an evaluator.
 *
 * @param expression - The formula, e.g. `(A - B) / C` or `MOV(Pos.1, 5)`.
 * @param columnNames - Ordered list of available column names (used for name→index mapping).
 * @returns A compiled expression that can be evaluated against column data.
 */
/**
 * One input port's slice of the flat column list — mirrors `AliasRange` in
 * `backend/src/expression.h`. A card with several tables needs `A.pos.1` / `B.温度` to say
 * which table a column belongs to.
 */
export interface AliasRange {
  alias: string;
  first: number;
  count: number;
}

/**
 * Every spelling a column answers to (first = its display label).
 *
 * An annotated column's display label is "Pos.1 时间_秒", so registering only that string
 * made the column unreachable by any name: the annotation did not tokenise before the
 * Unicode identifier rule and `Pos.1` missed because the position name had been glued to
 * the annotation. Both spellings are what the card advertises, so both resolve.
 */
export function keysForColumn(label: string): string[] {
  const lower = label.toLowerCase();
  const keys = [lower];
  const space = lower.indexOf(' ');
  if (lower.startsWith('pos.')) {
    const posName = space < 0 ? lower : lower.slice(0, space);
    keys.push(posName); // "pos.1"
    if (posName.length > 4) keys.push(posName.slice(4)); // its number: "1"
    if (space >= 0 && space + 1 < lower.length) keys.push(lower.slice(space + 1)); // annotation
  } else if (space >= 0 && space + 1 < lower.length) {
    keys.push(lower.slice(space + 1));
  }
  return keys;
}

export function compile(
  expression: string,
  columnNames: string[],
  aliases: AliasRange[] = [],
): CompiledExpression {
  const columns = new Map<string, number>();
  const references: string[] = [];

  const keysByColumn: string[][] = [];
  for (let i = 0; i < columnNames.length; i++) {
    const name = columnNames[i];
    keysByColumn.push(keysForColumn(name));
    // The full label keeps last-wins (duplicates resolve to the last one, as before);
    // every alias is additive and first-wins, so an earlier column is never shadowed.
    columns.set(name.toLowerCase(), i);
    for (let k = 1; k < keysByColumn[i].length; k++) {
      if (!columns.has(keysByColumn[i][k])) columns.set(keysByColumn[i][k], i);
    }
  }
  // Qualified references (`A.pos.1`, `A.时间_秒`, `A.[地面速度_μm/s]`).
  for (const range of aliases) {
    if (!range.alias) continue;
    const prefix = `${range.alias.toLowerCase()}.`;
    const end = Math.min(columnNames.length, range.first + range.count);
    for (let i = range.first; i < end; i++) {
      for (const key of keysByColumn[i]) {
        if (!columns.has(prefix + key)) columns.set(prefix + key, i);
      }
    }
  }

  const tokens = tokenize(expression);
  const ast = parse(tokens, { columns });

  // Collect referenced column names from the AST.
  function collectRefs(node: ASTNode): void {
    switch (node.kind) {
      case 'column':
        if (!references.includes(node.name)) references.push(node.name);
        break;
      case 'binary':
        collectRefs(node.left);
        collectRefs(node.right);
        break;
      case 'unary':
        collectRefs(node.operand);
        break;
      case 'call':
        for (const arg of node.args) collectRefs(arg);
        break;
    }
  }
  collectRefs(ast);

  return {
    source: expression,
    references,
    evaluate: compileAST(ast),
  };
}

/**
 * Evaluate an expression against a MatrixData-like column store.
 * Convenience wrapper around `compile()` + `evaluate()`.
 */
export function evaluateExpression(
  expression: string,
  columns: Array<{ name: string; data: number[] }>,
): number[] {
  const names = columns.map((c) => c.name);
  const data = columns.map((c) => c.data);
  let length = data.reduce((max, col) => Math.max(max, col.length), 0);
  // Pure-constant expressions (no column refs) still need at least one row to evaluate.
  if (length === 0) length = 1;
  const compiled = compile(expression, names);
  return compiled.evaluate(data, length);
}
