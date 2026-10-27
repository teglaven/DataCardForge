// Built-in signature registry. See signature.h and
// docs/architecture/port-semantics-v1.md for the semantics this table encodes.
#include "signature.h"

namespace dc {

const char* const kSigExpressionColumns = "builtin:expression-columns";
const char* const kSigLinearRegression = "builtin:linear-regression";

namespace {

// `builtin:expression-columns` — the v1 formula card, expressed as a signature.
//
// One input port (the whole source table), one output (a wide table with one column per
// expression). This replaces the v1 "one compute node per formula column" mapping: the
// same computation now happens once, in one node, and the K-columns-per-formula merge
// happens server-side instead of in the browser. K stays 1 here deliberately — a variable
// number of *columns* inside one table is data, not a K-output:
//   "变长/变个数的结果装进一个 table 输出" (port-semantics-v1 §outputs).
const FunctionSignature& expressionColumns() {
  static const FunctionSignature kSig = [] {
    FunctionSignature s;
    s.id = kSigExpressionColumns;
    s.version = 1;
    s.displayName = "expression columns";
    s.inputs = {{"src", "source table", true}};
    s.outputs = {{"result"}};
    return s;
  }();
  return kSig;
}

// `builtin:linear-regression` — the first signature that is NOT expression-shaped.
//
// Two input ports (x and y), no expression parameters, and one output whose shape does not
// follow the input at all: a single row of five named statistics. It exists to prove the
// signature registry is general — N inputs, parameters that are not formulas, and an output
// whose height is fixed by the signature rather than by the data.
const FunctionSignature& linearRegression() {
  static const FunctionSignature kSig = [] {
    FunctionSignature s;
    s.id = kSigLinearRegression;
    s.version = 1;
    s.displayName = "linear regression";
    s.inputs = {{"x", "x values", true}, {"y", "y values", true}};
    s.outputs = {{"fit"}};
    return s;
  }();
  return kSig;
}

}  // namespace

const FunctionSignature* findSignature(const std::string& id) {
  if (id == kSigExpressionColumns) return &expressionColumns();
  if (id == kSigLinearRegression) return &linearRegression();
  return nullptr;
}

std::vector<const FunctionSignature*> allSignatures() {
  return {&expressionColumns(), &linearRegression()};
}

}  // namespace dc
