// Column expression engine — C++ port of web/src/core/expression.ts.
//
// Differential contract (docs/architecture/backend-protocol-v1.md): this file and the
// TS reference must agree on every case in web/tests/fixtures/xlayer/*.json, including
// error codes and positions. When changing one side, change the other and re-run both
// fixture runners. Semantics deliberately mirrored:
//   - identifiers resolve case-insensitively; "Pos.N" also registers under "N"
//   - aggregations reduce to a scalar then broadcast; NaN values are skipped
//   - MIN/MAX single-arg aggregate, multi-arg element-wise
//   - STD is Bessel-corrected (n-1); n<=1 yields 0
//   - comparison ops yield 1/0; division by zero follows IEEE (±Infinity)
//   - "^" right-associative; MOV window clamps at the edges; EMA seeds out[0]=data[0]
#pragma once

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace dc {

struct ExpressionError : std::runtime_error {
  std::string code;
  int64_t position = -1;
  // The thing the message names in quotes (offending character, column, function or
  // token). The message already embeds it, but a client that localises the error needs
  // the value as data — the UI printed a literal "{char}" for two months because only
  // `position` travelled over the wire.
  std::string detail;
  // badArgCount only: the declared arity (argMax = INT32_MAX for a variadic function) and
  // the arity the expression actually supplied.
  int64_t argMin = -1;
  int64_t argMax = -1;
  int64_t argGot = -1;
  ExpressionError(std::string message, int64_t pos, std::string code_)
      : std::runtime_error(std::move(message)), code(std::move(code_)), position(pos) {}
  ExpressionError(std::string message, int64_t pos, std::string code_, std::string detail_)
      : std::runtime_error(std::move(message)),
        code(std::move(code_)),
        position(pos),
        detail(std::move(detail_)) {}
};

/**
 * One input port's slice of the flat column list.
 *
 * A function card can bind several tables, so the expression needs a way to say *which*
 * table a column belongs to: `A.pos.1`, `A.温度`, `A.[地面速度_μm/s]`. The alias is the
 * port identity the card shows (its letter of the declaration order, or the port id), and
 * the range is where that port's columns live in `columnNames`.
 */
struct AliasRange {
  std::string alias;
  size_t first = 0;
  size_t count = 0;
};

// Forward declaration — full definition in matrix_value.h.
class MatVal;

class ExprEngine {
 public:
  // columnNames are matched case-insensitively ("Pos.N" additionally under "N"). Every
  // column also answers to its `Pos.N` name, its bare number, and its annotation, so an
  // annotated table is addressable by any of the spellings its card advertises. Doubly
  // bracketed `[名字]` binds a name verbatim (for names with `/`, spaces, parentheses).
  // Throws ExpressionError on any parse/compile failure (codes match the TS engine).
  static std::vector<double> evaluate(const std::string& expression,
                                      const std::vector<std::string>& columnNames,
                                      const std::vector<std::vector<double>>& columns,
                                      size_t length,
                                      const std::vector<AliasRange>& aliases = {});

  /**
   * Matrix-mode evaluation. Each input is a full matrix (rows×cols). The formula uses
   * matrix semantics: `*` = matmul, TRANSPOSE/DET/INV/SOLVE available. Returns the
   * result as a flat column-major vector with shape written to outRows/outCols.
   *
   * @param matrixModeVars  Set of variable names that are matrix-mode (uppercase first
   *                        letter by convention, but explicitly declared in the port).
   * @throws ShapeError     Dimension mismatch in matrix ops.
   * @throws ExpressionError Parse/unknown-function errors (same codes as cell mode).
   */
  static std::vector<double> evaluateMatrix(
      const std::string& expression,
      const std::vector<std::string>& varNames,
      const std::vector<MatVal>& inputs,
      int64_t* outRows, int64_t* outCols);

  // Names actually referenced by the expression (original spelling, first occurrence),
  // matching CompiledExpression.references on the TS side.
  static std::vector<std::string> references(const std::string& expression,
                                             const std::vector<std::string>& columnNames);
};

}  // namespace dc
