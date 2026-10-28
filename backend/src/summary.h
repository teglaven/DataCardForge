// `builtin:summary` — the statistic table: rows = statistics, columns = input variables.
//
// This file is the pure computation half of the signature. It owns NO arithmetic: every
// statistic is one expression evaluated by the same engine the formula card uses
// (expression.h), which is the engine the cross-tier fixtures referee. Duplicating the
// maths here would create the second definition of "sample standard deviation" that the
// 2026-10-26 decision went to some length to avoid.
//
// Contract (docs/decisions/2026-10-27-summary-builtin.md):
//   - row order  = summaryStatCatalog() order (signature.h); never user-reordered;
//   - row identity = the catalog id at that index (no row-label channel exists on the
//     wire — Matrix carries column labels only);
//   - columns    = the selected input variables, in input order, labels inherited
//     verbatim from the source column (annotation when present, else its posName);
//   - K stays 1: the row count is data, not a signature output count.
#pragma once

#include <string>
#include <vector>

#include "json.h"
#include "matrix_store.h"

namespace dc {

struct SummaryResult {
  // One column per selected input variable, each `rows` values long, in catalog order.
  std::vector<Column> columns;
  // Structured failure. `errorCode` empty ⇒ success; on failure `columns` is empty.
  std::string errorCode;
  // The offending name (parameter name or column name) for the error params.
  std::string errorName;
};

// Evaluate the summary table for `input` under `params`.
//
// `params.columns` (optional, string[]): which variables to summarise, matched
//   case-insensitively against the column annotation (an un-annotated column is matched
//   by its posName). Absent ⇒ every column. An explicitly empty array is a structured
//   error, not a zero-column table: a summary of nothing is a mistake, and a 0-column
//   result cannot even be bound downstream (the port resolver rejects it).
// `params.stats` (optional, string[]): which catalog ids to emit. Absent ⇒ the whole
//   catalog. Emitted rows always follow catalog order regardless of the order given.
SummaryResult evaluateSummary(const std::vector<Column>& input, const Json& params);

}  // namespace dc
