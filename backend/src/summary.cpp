// evaluateSummary — the pure computation half of `builtin:summary` (summary.h).
//
// This file owns NO arithmetic. Each statistic is one engine expression over the
// single variable "A" (expression.h), so "sample standard deviation" and friends
// have exactly one definition in the process — the same one the formula card and
// the xlayer fixtures use (docs/decisions/2026-10-27-summary-builtin.md). What this
// file does: validate params, filter the catalog / select the columns, and call
// ExprEngine::evaluate per (column, statistic) pair.
#include "summary.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "expression.h"
#include "signature.h"

namespace dc {

namespace {

// Catalog id -> engine expression. The catalog (signature.h) is the single source
// of the row set and its order; this table only binds each stable row identity to
// the one expression that computes it. If an id ever lacks an entry that is a
// code bug (internalError), never a silent NaN.
const std::unordered_map<std::string, const char*>& statExpressions() {
  static const std::unordered_map<std::string, const char*> kTable = {
      {"n", "COUNT(A)"},
      {"nan", "NAN(A)"},
      {"mean", "MEAN(A)"},
      {"sd", "STD(A)"},
      {"var", "VAR(A)"},
      {"min", "MIN(A)"},
      {"q1", "QUANTILE(A, 0.25)"},
      {"median", "QUANTILE(A, 0.5)"},
      {"q3", "QUANTILE(A, 0.75)"},
      {"max", "MAX(A)"},
      {"iqr", "QUANTILE(A, 0.75) - QUANTILE(A, 0.25)"},
      {"sem", "SEM(A)"},
  };
  return kTable;
}

std::string toLower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

}  // namespace

SummaryResult evaluateSummary(const std::vector<Column>& input, const Json& params) {
  SummaryResult result;
  const std::vector<std::string>& catalog = summaryStatCatalog();

  // --- Step 1: stats -----------------------------------------------------------
  // Output rows ALWAYS follow catalog order; `params.stats` (case-insensitive)
  // only filters the subset. Absent ⇒ the whole catalog.
  std::vector<bool> selected(catalog.size(), false);
  const Json* statsParam = params.find("stats");
  if (statsParam == nullptr) {
    std::fill(selected.begin(), selected.end(), true);
  } else {
    if (!statsParam->isArray() || statsParam->items().empty()) {
      result.errorCode = "badSignatureParams";
      result.errorName = "stats";
      return result;
    }
    for (const Json& item : statsParam->items()) {
      if (!item.isString()) {
        result.errorCode = "badSignatureParams";
        result.errorName = "stats";
        return result;
      }
      const std::string id = toLower(item.asString());
      bool found = false;
      for (size_t i = 0; i < catalog.size(); ++i) {
        if (toLower(catalog[i]) == id) {
          found = true;
          selected[i] = true;
        }
      }
      if (!found) {
        result.errorCode = "badSignatureParams";
        result.errorName = item.asString();  // the offending item, as given
        return result;
      }
    }
  }

  // --- Step 2: columns ---------------------------------------------------------
  // Match key = annotation when present, else posName; compared case-insensitively.
  // Absent ⇒ every input column, in input order. An output column is a variable,
  // so it appears at most once and in input order regardless of the order the
  // user typed in `params.columns`.
  std::vector<size_t> chosen;
  const Json* columnsParam = params.find("columns");
  if (columnsParam == nullptr) {
    for (size_t i = 0; i < input.size(); ++i) chosen.push_back(i);
  } else {
    if (!columnsParam->isArray() || columnsParam->items().empty()) {
      result.errorCode = "badSignatureParams";
      result.errorName = "columns";
      return result;
    }
    auto keyOf = [](const Column& c) {
      return c.annotation.empty() ? c.posName : c.annotation;
    };
    // First pass: every requested name must match at least one column.
    std::unordered_set<std::string> wanted;
    for (const Json& item : columnsParam->items()) {
      if (!item.isString()) {
        result.errorCode = "badSignatureParams";
        result.errorName = "columns";
        return result;
      }
      const std::string name = item.asString();
      const std::string key = toLower(name);
      bool found = false;
      for (size_t i = 0; i < input.size(); ++i) {
        if (toLower(keyOf(input[i])) == key) {
          found = true;
          break;
        }
      }
      if (!found) {
        result.errorCode = "unknownColumn";
        result.errorName = name;  // the user's string, as given
        return result;
      }
      wanted.insert(key);
    }
    // Second pass: walk the input in order and keep the selected columns once each.
    for (size_t i = 0; i < input.size(); ++i) {
      if (wanted.count(toLower(keyOf(input[i]))) != 0) chosen.push_back(i);
    }
  }

  // --- Step 3+4: one value per (selected column, selected statistic) -----------
  // length = 1 is deliberate: the aggregations reduce the whole column data
  // (columns[0]); `length` only decides the broadcast length, so an empty column
  // still yields a scalar (COUNT → 0) instead of an empty vector.
  const auto& table = statExpressions();
  const std::vector<std::string> names = {"A"};
  for (size_t idx : chosen) {
    Column out;
    out.posName = input[idx].posName;      // inherited verbatim — this is what keeps
    out.annotation = input[idx].annotation; // an un-annotated column named "Pos.7"
    const std::vector<double>& colData = input[idx].data;
    for (size_t i = 0; i < catalog.size(); ++i) {
      if (!selected[i]) continue;
      const auto it = table.find(catalog[i]);
      if (it == table.end()) {
        // The catalog is a constant; a missing expression is a code bug. Fail loudly
        // instead of silently emitting NaN.
        result.errorCode = "internalError";
        result.errorName = catalog[i];
        return result;
      }
      std::vector<double> value = ExprEngine::evaluate(it->second, names, {colData}, 1);
      out.data.push_back(value.empty() ? NAN : value[0]);
    }
    result.columns.push_back(std::move(out));
  }
  return result;
}

}  // namespace dc
