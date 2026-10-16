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
  ExpressionError(std::string message, int64_t pos, std::string code_)
      : std::runtime_error(std::move(message)), code(std::move(code_)), position(pos) {}
};

class ExprEngine {
 public:
  // columnNames are matched case-insensitively ("Pos.N" additionally under "N").
  // Throws ExpressionError on any parse/compile failure (codes match the TS engine).
  static std::vector<double> evaluate(const std::string& expression,
                                      const std::vector<std::string>& columnNames,
                                      const std::vector<std::vector<double>>& columns,
                                      size_t length);

  // Names actually referenced by the expression (original spelling, first occurrence),
  // matching CompiledExpression.references on the TS side.
  static std::vector<std::string> references(const std::string& expression,
                                             const std::vector<std::string>& columnNames);
};

}  // namespace dc
