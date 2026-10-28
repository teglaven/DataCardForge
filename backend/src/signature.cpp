// Built-in signature registry. See signature.h and
// docs/architecture/port-semantics-v1.md for the semantics this table encodes.
#include "signature.h"

namespace dc {

const char* const kSigExpressionColumns = "builtin:expression-columns";
const char* const kSigLinearRegression = "builtin:linear-regression";
const char* const kSigSummary = "builtin:summary";

// The statistic catalog. Order == output row order. Ids are stable identities: renaming
// one would silently re-label every stored summary card, so they are frozen here exactly
// as published (docs/decisions/2026-10-27-summary-builtin.md).
//
// Kept as one table so the registry, the evaluator (summary.cpp) and the fixtures all
// read the same order instead of each carrying a copy of "the twelve".
const std::vector<std::string>& summaryStatCatalog() {
  static const std::vector<std::string> kCatalog = {
      "n", "nan", "mean", "sd", "var", "min", "q1", "median", "q3", "max", "iqr", "sem"};
  return kCatalog;
}

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

// `builtin:summary` — the statistic table. One matrix port in, one table out whose rows
// are the catalog entries and whose columns are the input variables.
//
// It is the first signature with `explicitCompute`: creating it does NOT compute. That is
// a property of the capability (a summary over a wide table is the expensive one), and it
// is what makes "not requested yet" distinguishable from "upstream changed" — see
// docs/decisions/2026-10-27-summary-builtin.md §lazy.
const FunctionSignature& summary() {
  static const FunctionSignature kSig = [] {
    FunctionSignature s;
    s.id = kSigSummary;
    s.version = 1;
    s.displayName = "summary";
    s.inputs = {{"src", "source table", true}};
    s.outputs = {{"result"}};
    s.explicitCompute = true;
    return s;
  }();
  return kSig;
}

const FunctionSignature* findSignature(const std::string& id) {
  if (id == kSigExpressionColumns) return &expressionColumns();
  if (id == kSigLinearRegression) return &linearRegression();
  if (id == kSigSummary) return &summary();
  return nullptr;
}

std::vector<const FunctionSignature*> allSignatures() {
  return {&expressionColumns(), &linearRegression(), &summary()};
}

}  // namespace dc
