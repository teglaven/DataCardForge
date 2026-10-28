import { describe, expect, it } from 'vitest';
import { compile, evaluateExpression, ExpressionError } from '../src/core/expression.ts';

const cols = (data: Record<string, number[]>) =>
  Object.entries(data).map(([name, d]) => ({ name, data: d }));

describe('expression engine', () => {
  describe('basic arithmetic', () => {
    it('evaluates simple addition', () => {
      const result = evaluateExpression('A + B', cols({ A: [1, 2, 3], B: [4, 5, 6] }));
      expect(result).toEqual([5, 7, 9]);
    });

    it('respects operator precedence', () => {
      const result = evaluateExpression('A + B * C', cols({ A: [1], B: [2], C: [3] }));
      expect(result).toEqual([7]);
    });

    it('handles parentheses', () => {
      const result = evaluateExpression('(A + B) * C', cols({ A: [1], B: [2], C: [3] }));
      expect(result).toEqual([9]);
    });

    it('handles unary minus', () => {
      const result = evaluateExpression('-A + B', cols({ A: [3], B: [10] }));
      expect(result).toEqual([7]);
    });

    it('handles exponentiation (right-associative)', () => {
      const result = evaluateExpression('2 ^ 3 ^ 2', cols({}));
      // 2^(3^2) = 2^9 = 512, not (2^3)^2 = 64
      expect(result).toEqual([512]);
    });

    it('handles modulo', () => {
      const result = evaluateExpression('A % 3', cols({ A: [7, 8, 9] }));
      expect(result).toEqual([1, 2, 0]);
    });

    it('handles division by zero as Infinity', () => {
      const result = evaluateExpression('A / B', cols({ A: [1], B: [0] }));
      expect(result[0]).toBe(Infinity);
    });
  });

  describe('comparisons', () => {
    it('returns 1/0 for true/false', () => {
      const result = evaluateExpression('A > B', cols({ A: [5, 3, 1], B: [2, 3, 4] }));
      expect(result).toEqual([1, 0, 0]);
    });

    it('supports == and !=', () => {
      expect(evaluateExpression('A == 2', cols({ A: [1, 2, 3] }))).toEqual([0, 1, 0]);
      expect(evaluateExpression('A != 2', cols({ A: [1, 2, 3] }))).toEqual([1, 0, 1]);
    });
  });

  describe('aggregation functions', () => {
    it('SUM reduces to scalar and broadcasts', () => {
      const result = evaluateExpression('SUM(A)', cols({ A: [1, 2, 3, 4] }));
      expect(result).toEqual([10, 10, 10, 10]);
    });

    it('AVG computes mean', () => {
      const result = evaluateExpression('AVG(A)', cols({ A: [2, 4, 6] }));
      expect(result).toEqual([4, 4, 4]);
    });

    it('MIN/MAX with single arg reduce to scalar', () => {
      expect(evaluateExpression('MIN(A)', cols({ A: [3, 1, 2] }))).toEqual([1, 1, 1]);
      expect(evaluateExpression('MAX(A)', cols({ A: [3, 1, 2] }))).toEqual([3, 3, 3]);
    });

    it('MIN/MAX with multiple args are element-wise', () => {
      const result = evaluateExpression('MIN(A, B)', cols({ A: [1, 5, 3], B: [4, 2, 6] }));
      expect(result).toEqual([1, 2, 3]);
    });

    it('MEDIAN computes correctly', () => {
      expect(evaluateExpression('MEDIAN(A)', cols({ A: [1, 3, 2] }))).toEqual([2, 2, 2]);
      expect(evaluateExpression('MEDIAN(A)', cols({ A: [1, 2, 3, 4] }))).toEqual([2.5, 2.5, 2.5, 2.5]);
    });

    it('STD computes sample standard deviation', () => {
      const result = evaluateExpression('STD(A)', cols({ A: [2, 4, 4, 4, 5, 5, 7, 9] }));
      expect(result[0]).toBeCloseTo(2.138, 2);
    });

    it('ignores NaN in aggregations', () => {
      const result = evaluateExpression('SUM(A)', cols({ A: [1, NaN, 3] }));
      expect(result).toEqual([4, 4, 4]);
    });
  });

  describe('element-wise math', () => {
    it('ABS', () => {
      expect(evaluateExpression('ABS(A)', cols({ A: [-3, 0, 5] }))).toEqual([3, 0, 5]);
    });

    it('SQRT', () => {
      expect(evaluateExpression('SQRT(A)', cols({ A: [4, 9, 16] }))).toEqual([2, 3, 4]);
    });

    it('LOG / LN / LOG10', () => {
      expect(evaluateExpression('LN(A)', cols({ A: [Math.E] }))[0]).toBeCloseTo(1);
      expect(evaluateExpression('LOG10(A)', cols({ A: [100] }))[0]).toBeCloseTo(2);
    });

    it('ROUND with optional decimals', () => {
      expect(evaluateExpression('ROUND(A, 1)', cols({ A: [3.14159] }))[0]).toBeCloseTo(3.1);
      expect(evaluateExpression('ROUND(A)', cols({ A: [3.7] }))[0]).toBe(4);
    });
  });

  describe('moving window functions', () => {
    it('MOV computes moving average', () => {
      const result = evaluateExpression('MOV(A, 3)', cols({ A: [1, 2, 3, 4, 5] }));
      // Window 3, half=1: [1,2]/2=1.5, [1,2,3]/3=2, [2,3,4]/3=3, [3,4,5]/3=4, [4,5]/2=4.5
      expect(result[0]).toBeCloseTo(1.5);
      expect(result[2]).toBeCloseTo(3);
      expect(result[4]).toBeCloseTo(4.5);
    });

    it('EMA computes exponential moving average', () => {
      const result = evaluateExpression('EMA(A, 0.5)', cols({ A: [10, 20, 30] }));
      expect(result[0]).toBe(10);
      expect(result[1]).toBeCloseTo(15);
      expect(result[2]).toBeCloseTo(22.5);
    });
  });

  describe('IF conditional', () => {
    it('selects true/false branches element-wise', () => {
      const result = evaluateExpression(
        'IF(A > 0, A, 0)',
        cols({ A: [-1, 2, -3, 4] }),
      );
      expect(result).toEqual([0, 2, 0, 4]);
    });

    it('works with column references in branches', () => {
      const result = evaluateExpression(
        'IF(A > B, A, B)',
        cols({ A: [1, 5], B: [3, 2] }),
      );
      expect(result).toEqual([3, 5]);
    });
  });

  describe('column name resolution', () => {
    it('resolves Pos.N names', () => {
      const result = evaluateExpression('Pos.1 + Pos.2', cols({ 'Pos.1': [1], 'Pos.2': [2] }));
      expect(result).toEqual([3]);
    });

    it('resolves short numeric suffix (1 instead of Pos.1)', () => {
      const result = evaluateExpression('1 + 2', cols({ 'Pos.1': [10], 'Pos.2': [20] }));
      // "1" and "2" are parsed as number literals, not column refs
      expect(result).toEqual([3]);
    });

    it('is case-insensitive', () => {
      const result = evaluateExpression('a + b', cols({ A: [1], B: [2] }));
      expect(result).toEqual([3]);
    });
  });

  describe('error handling', () => {
    it('throws on unknown column', () => {
      expect(() => compile('X + 1', ['A', 'B'])).toThrow(ExpressionError);
    });

    it('throws on unknown function', () => {
      expect(() => compile('FOO(A)', ['A'])).toThrow(ExpressionError);
    });

    it('throws on wrong argument count', () => {
      expect(() => compile('IF(A, B)', ['A', 'B'])).toThrow(ExpressionError);
    });

    it('throws on unexpected character', () => {
      expect(() => compile('A @ B', ['A', 'B'])).toThrow(ExpressionError);
    });

    it('reports position in error message', () => {
      try {
        compile('A + @', ['A']);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ExpressionError);
        expect((e as ExpressionError).position).toBe(4);
      }
    });
  });

  describe('compiled expression metadata', () => {
    it('tracks referenced columns', () => {
      const compiled = compile('A + B * 2', ['A', 'B', 'C']);
      expect(compiled.references.sort()).toEqual(['A', 'B']);
    });

    it('preserves source text', () => {
      const compiled = compile('  A + B  ', ['A', 'B']);
      expect(compiled.source).toBe('  A + B  ');
    });
  });

  describe('realistic formulas', () => {
    it('normalises a column to [0,1]', () => {
      const result = evaluateExpression(
        '(A - MIN(A)) / (MAX(A) - MIN(A))',
        cols({ A: [2, 4, 6, 8, 10] }),
      );
      expect(result[0]).toBeCloseTo(0);
      expect(result[2]).toBeCloseTo(0.5);
      expect(result[4]).toBeCloseTo(1);
    });

    it('clips outliers with IF', () => {
      const result = evaluateExpression(
        'IF(A > AVG(A) + 2*STD(A), AVG(A), A)',
        cols({ A: [1, 2, 3, 100, 2, 3] }),
      );
      // Mean ≈ 18.5, STD ≈ 37.5, threshold ≈ 93.5. Only 100 exceeds it.
      // Non-outliers keep their original value; the outlier becomes the mean.
      expect(result[0]).toBe(1);   // kept
      expect(result[3]).toBeCloseTo(18.5); // replaced by mean
    });

    it('computes percentage change', () => {
      const result = evaluateExpression(
        '(A - MOV(A, 2)) / MOV(A, 2) * 100',
        cols({ A: [100, 110, 105, 120] }),
      );
      expect(result.length).toBe(4);
      expect(result.every(Number.isFinite)).toBe(true);
    });
  });

  /**
   * The summary statistics. Values here are pinned by reasoning about the definition, not
   * by asking the implementation: the cross-tier fixtures (xlayer/expression.v1.json) are
   * the referee for C++ vs TS, so these tests must not simply record whatever comes out.
   */
  describe('summary statistics', () => {
    it('COUNT counts finite values only', () => {
      // 1 and 3 are finite; NaN and Infinity are not observations.
      expect(evaluateExpression('COUNT(A)', cols({ A: [1, Number.NaN, 3, Infinity] }))).toEqual([
        2, 2, 2, 2,
      ]);
      expect(evaluateExpression('COUNT(A)', cols({ A: [] }))).toEqual([0]);
    });

    it('NAN counts NaN only, not infinities', () => {
      expect(
        evaluateExpression('NAN(A)', cols({ A: [1, Number.NaN, Infinity, Number.NaN] })),
      ).toEqual([2, 2, 2, 2]);
      expect(evaluateExpression('NAN(A)', cols({ A: [] }))).toEqual([0]);
    });

    it('VAR is the sample variance (ddof = n-1)', () => {
      // [1,2,3,4]: mean 2.5, ss = 2.25+0.25+0.25+2.25 = 5, var = 5/3.
      expect(evaluateExpression('VAR(A)', cols({ A: [1, 2, 3, 4] }))[0]).toBeCloseTo(5 / 3, 15);
      expect(evaluateExpression('VAR(A)', cols({ A: [5] }))).toEqual([0]); // n = 1 → 0
      expect(evaluateExpression('VAR(A)', cols({ A: [] }))[0]).toBeNaN(); // n = 0 → undefined
    });

    it('STD of an empty column is NaN, not 0', () => {
      expect(evaluateExpression('STD(A)', cols({ A: [5] }))).toEqual([0]); // n = 1 → 0
      expect(evaluateExpression('STD(A)', cols({ A: [] }))[0]).toBeNaN(); // n = 0 → undefined
    });

    it('SEM is sd/sqrt(n) and 0 below two observations', () => {
      const sd = Math.sqrt(5 / 3);
      expect(evaluateExpression('SEM(A)', cols({ A: [1, 2, 3, 4] }))[0]).toBeCloseTo(sd / 2, 15);
      expect(evaluateExpression('SEM(A)', cols({ A: [5] }))).toEqual([0]);
      expect(evaluateExpression('SEM(A)', cols({ A: [] }))).toEqual([0]);
    });

    it('QUANTILE follows R-7 linear interpolation', () => {
      // [1,2,3,4]: pos = 3q. q=0.25 → 0.75 → 1 + 0.75 = 1.75; q=0.5 → 1.5 → 2.5;
      // q=0.75 → 2.25 → 3 + 0.25 = 3.25.
      expect(evaluateExpression('QUANTILE(A, 0.25)', cols({ A: [1, 2, 3, 4] }))[0]).toBeCloseTo(1.75, 15);
      expect(evaluateExpression('QUANTILE(A, 0.5)', cols({ A: [1, 2, 3, 4] }))[0]).toBeCloseTo(2.5, 15);
      expect(evaluateExpression('QUANTILE(A, 0.75)', cols({ A: [1, 2, 3, 4] }))[0]).toBeCloseTo(3.25, 15);
      // Odd count: the middle element is hit exactly.
      expect(evaluateExpression('QUANTILE(A, 0.5)', cols({ A: [3, 1, 2] }))[0]).toBe(2);
    });

    it('QUANTILE clamps q out of range and returns NaN for a non-finite q', () => {
      expect(evaluateExpression('QUANTILE(A, -1)', cols({ A: [3, 1, 2] }))[0]).toBe(1);
      expect(evaluateExpression('QUANTILE(A, 2)', cols({ A: [3, 1, 2] }))[0]).toBe(3);
      expect(evaluateExpression('QUANTILE(A, 0)', cols({ A: [3, 1, 2] }))[0]).toBe(1);
      expect(evaluateExpression('QUANTILE(A, 1)', cols({ A: [3, 1, 2] }))[0]).toBe(3);
      expect(
        evaluateExpression('QUANTILE(A, B)', cols({ A: [1, 2, 3], B: [Number.NaN, Number.NaN, Number.NaN] }))[0],
      ).toBeNaN();
    });

    it('QUANTILE takes q per row when q is a column', () => {
      const result = evaluateExpression(
        'QUANTILE(A, B)',
        cols({ A: [1, 2, 3, 4], B: [0, 0.25, 0.5, 0.75] }),
      );
      expect(result[0]).toBeCloseTo(1, 15);
      expect(result[1]).toBeCloseTo(1.75, 15);
      expect(result[2]).toBeCloseTo(2.5, 15);
      expect(result[3]).toBeCloseTo(3.25, 15);
    });

    it('QUANTILE ignores non-finite observations', () => {
      // finite = [1,3,4] → sorted, q=0.5 → pos 1 → 3.
      expect(
        evaluateExpression('QUANTILE(A, 0.5)', cols({ A: [1, Number.NaN, 3, Infinity, 4] }))[0],
      ).toBe(3);
      expect(
        evaluateExpression('QUANTILE(A, 0.5)', cols({ A: [Number.NaN, Number.NaN] }))[0],
      ).toBeNaN();
    });
  });
  /**
   * Annotated tables used to be unaddressable by every spelling: the display label is
   * "Pos.1 时间_秒", the annotation did not tokenise (ASCII-only identifiers), and `Pos.1`
   * missed because the position name had been glued to the annotation. These pin both
   * spellings plus the bracketed form for names containing reserved symbols.
   */
  describe('column reference spellings', () => {
    const annotated = cols({
      'Pos.1 时间_秒': [1, 2],
      'Pos.2 地面速度_μm/s': [10, 20],
    });

    it('resolves the position name of an annotated column', () => {
      expect(evaluateExpression('Pos.1 + Pos.2', annotated)).toEqual([11, 22]);
    });

    it('resolves position names case-insensitively', () => {
      expect(evaluateExpression('pOs.1 * 2', annotated)).toEqual([2, 4]);
    });

    it('keeps numerals as numbers, not column numbers', () => {
      // The number spelling of Pos.N is unreachable by design: `1` is a literal, which is
      // why the position name is the only stable numeric handle. Locked here so the
      // alias table is never "fixed" into shadowing literals.
      expect(evaluateExpression('1 + 1', annotated)).toEqual([2, 2]);
    });

    it('resolves a CJK annotation by its own spelling', () => {
      expect(evaluateExpression('时间_秒 * 2', annotated)).toEqual([2, 4]);
    });

    it('resolves a bracketed name verbatim, including "/" and "μ"', () => {
      expect(evaluateExpression('[地面速度_μm/s] / 2', annotated)).toEqual([5, 10]);
      expect(evaluateExpression('[ Pos.1 ] + 1', annotated)).toEqual([2, 3]);
    });

    it('accepts full-width brackets and punctuation', () => {
      expect(evaluateExpression('【地面速度_μm/s】／2', annotated)).toEqual([5, 10]);
      expect(evaluateExpression('（时间_秒 ＋ 1）× 2', annotated)).toEqual([4, 6]);
      expect(evaluateExpression('IF(时间_秒 > 1， 1， 0)', annotated)).toEqual([0, 1]);
    });

    it('treats a bracketed name as a column, never a function call', () => {
      const named = cols({ 'Pos.1 SUM': [4, 5] });
      expect(evaluateExpression('[SUM] * 2', named)).toEqual([8, 10]);
    });

    it('names the offending token on an unknown column', () => {
      try {
        evaluateExpression('Pos.9 * 2', annotated);
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError);
        const e = error as ExpressionError;
        expect(e.code).toBe('unknownColumn');
        expect(e.params.name).toBe('Pos.9');
      }
    });
  });

  /**
   * Multi-input cards qualify a reference with the port: `A.pos.1`, `src.温度`,
   * `A.[地面速度_μm/s]`. The letter follows the port declaration order; the port id works
   * too, and both are case-insensitive.
   */
  describe('qualified references', () => {
    const names = ['Pos.1 时间_秒', 'Pos.2 地面速度_μm/s'];
    const data = [
      [1, 2],
      [10, 20],
    ];
    const aliases = [
      { alias: 'A', first: 0, count: 2 },
      { alias: 'src', first: 0, count: 2 },
    ];

    const run = (expression: string) => compile(expression, names, aliases).evaluate(data, 2);

    it('resolves a qualified position name', () => {
      expect(run('A.pos.2 / 2')).toEqual([5, 10]);
      expect(run('a.POS.1 + 1')).toEqual([2, 3]);
    });

    it('resolves a qualified annotation', () => {
      expect(run('A.时间_秒 * 2')).toEqual([2, 4]);
    });

    it('resolves a qualified bracketed name', () => {
      expect(run('A.[地面速度_μm/s] * 2')).toEqual([20, 40]);
      expect(run('A.【地面速度_μm/s】 * 2')).toEqual([20, 40]);
    });

    it('also accepts the port id as the qualifier', () => {
      expect(run('src.时间_秒 * 3')).toEqual([3, 6]);
    });

    it('keeps unqualified references working alongside qualified ones', () => {
      expect(run('时间_秒 + A.时间_秒')).toEqual([2, 4]);
    });

    it('reports an unknown qualifier as an unknown column', () => {
      try {
        run('C.pos.1');
        throw new Error('expected a throw');
      } catch (error) {
        expect((error as ExpressionError).code).toBe('unknownColumn');
      }
    });
  });

  describe('structured error params', () => {
    it('reports the offending character of a namespace', () => {
      try {
        evaluateExpression('A ^ :', cols({ A: [1] }));
        throw new Error('expected a throw');
      } catch (error) {
        const e = error as ExpressionError;
        expect(e.code).toBe('unexpectedChar');
        expect(e.params).toMatchObject({ char: ':', position: 4 });
      }
    });

    it('reports the declared arity of a bad call', () => {
      try {
        evaluateExpression('IF(A, 1)', cols({ A: [1] }));
        throw new Error('expected a throw');
      } catch (error) {
        const e = error as ExpressionError;
        expect(e.code).toBe('badArgCount');
        expect(e.params).toMatchObject({ name: 'IF', min: 3, max: 3, got: 2 });
      }
    });
  });
});
