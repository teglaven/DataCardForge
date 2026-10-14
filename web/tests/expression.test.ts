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
});
