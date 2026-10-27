// Built-in signature registry. See signature.h and
// docs/architecture/port-semantics-v1.md for the semantics this table encodes.
#include "signature.h"

namespace dc {

const char* const kSigExpressionColumns = "builtin:expression-columns";

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

}  // namespace

const FunctionSignature* findSignature(const std::string& id) {
  if (id == kSigExpressionColumns) return &expressionColumns();
  return nullptr;
}

std::vector<const FunctionSignature*> allSignatures() {
  return {&expressionColumns()};
}

}  // namespace dc
