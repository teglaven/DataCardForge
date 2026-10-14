/**
 * Column expression engine.
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
}

// ── Tokenizer ──────────────────────────────────────────────────────────

const OPERATORS = new Set(['+', '-', '*', '/', '^', '%']);
const COMPARES = ['>=', '<=', '==', '!=', '>', '<'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Skip whitespace.
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

    // Identifier: letter, underscore, digit, dot (for Pos.N names).
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[a-zA-Z0-9_.]/.test(input[i])) i++;
      tokens.push({ type: 'ident', value: input.slice(start, i), pos: start });
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

    throw new ExpressionError(`Unexpected character '${ch}' at position ${i}`, i);
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
const FUNCTIONS: Record<string, { minArgs: number; maxArgs: number }> = {
  // Aggregations (reduce a column to a scalar, then broadcast).
  SUM: { minArgs: 1, maxArgs: 1 },
  AVG: { minArgs: 1, maxArgs: 1 },
  MEAN: { minArgs: 1, maxArgs: 1 },
  MIN: { minArgs: 1, maxArgs: Infinity },
  MAX: { minArgs: 1, maxArgs: Infinity },
  MEDIAN: { minArgs: 1, maxArgs: 1 },
  STD: { minArgs: 1, maxArgs: 1 },
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

/** Aggregation functions that reduce a column to a scalar. */
const AGGREGATIONS = new Set(['SUM', 'AVG', 'MEAN', 'MIN', 'MAX', 'MEDIAN', 'STD']);

export class ExpressionError extends Error {
  constructor(message: string, public readonly position: number) {
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

      // Function call?
      if (peek().type === 'lparen') {
        const upper = name.toUpperCase();
        if (!(upper in FUNCTIONS)) {
          throw new ExpressionError(`Unknown function '${name}'`, token.pos);
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
          throw new ExpressionError(`Expected ')' after function arguments`, peek().pos);
        }
        advance(); // consume ')'

        const spec = FUNCTIONS[upper];
        if (args.length < spec.minArgs || args.length > spec.maxArgs) {
          throw new ExpressionError(
            `${name}() expects ${spec.minArgs}${spec.maxArgs === Infinity ? '+' : `–${spec.maxArgs}`} argument(s), got ${args.length}`,
            token.pos,
          );
        }
        return { kind: 'call', name: upper, args };
      }

      // Column reference.
      const lower = name.toLowerCase();
      const index = ctx.columns.get(lower);
      if (index === undefined) {
        throw new ExpressionError(`Unknown column '${name}'`, token.pos);
      }
      return { kind: 'column', index, name };
    }

    if (token.type === 'lparen') {
      advance();
      const expr = parseExpression();
      if (peek().type !== 'rparen') {
        throw new ExpressionError(`Expected ')'`, peek().pos);
      }
      advance();
      return expr;
    }

    throw new ExpressionError(`Unexpected token '${token.value || token.type}'`, token.pos);
  }

  const ast = parseExpression();
  if (peek().type !== 'eof') {
    throw new ExpressionError(`Unexpected token '${peek().value}' after expression`, peek().pos);
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
              scalar = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
              break;
            }
            default:
              scalar = NaN;
          }
          return new Array<number>(len).fill(scalar);
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
export function compile(expression: string, columnNames: string[]): CompiledExpression {
  const columns = new Map<string, number>();
  const references: string[] = [];

  for (let i = 0; i < columnNames.length; i++) {
    const name = columnNames[i];
    columns.set(name.toLowerCase(), i);
    // Also register without the "Pos." prefix for convenience.
    if (name.startsWith('Pos.')) {
      columns.set(name.slice(4).toLowerCase(), i);
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
