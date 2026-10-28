// Function signature registry — the C++ projection of docs/architecture/port-semantics-v1.md.
//
// A signature is the *shape* of a function card: its N input ports, its K output ports and
// the parameters it accepts. Built-in functions register here today; a future plugin is
// just another implementation of an existing signature (never a second entry point — the
// "one capability, one entry" rule from the port-semantics spec).
//
// Invariants carried by this header (locked in port-semantics-v1):
//   - portId / outputId are the identity; position is display order only;
//   - K is fixed by the signature and never by the data;
//   - parameters live in `params`, separate from the dataflow graph.
#pragma once

#include <string>
#include <vector>

#include "json.h"

namespace dc {

struct SignaturePort {
  std::string portId;       // stable identity, never renamed
  std::string displayName;  // human label; free to change
  bool required = true;
};

struct SignatureOutput {
  std::string outputId;     // stable identity, never renamed
};

struct FunctionSignature {
  std::string id;           // "builtin:expression-columns" — stable, never reused
  int version = 1;          // bump when the semantics change, never mutate under one id
  std::string displayName;
  std::vector<SignaturePort> inputs;
  std::vector<SignatureOutput> outputs;
  // Whether a node evaluates at creation (the v2 behaviour every existing signature
  // keeps) or only when the client explicitly asks, via POST /api/nodes/{id}/compute.
  // "When does it run" is a property of the capability, not of one card: the client
  // reads it from /api/signatures (`compute: "auto" | "explicit"`) and renders a
  // compute action instead of assuming the numbers exist.
  bool explicitCompute = false;
};

// Registry lookups. The returned pointers are valid for the process lifetime.
const FunctionSignature* findSignature(const std::string& id);
std::vector<const FunctionSignature*> allSignatures();

// Well-known built-in ids.
extern const char* const kSigExpressionColumns;
extern const char* const kSigLinearRegression;
extern const char* const kSigSummary;

// The summary statistic catalog. Its ORDER is the output row order of `builtin:summary`,
// and its ids are stable identities — never renamed, never reused, the same rule as
// portId/outputId. `params.stats` selects a SUBSET of this catalog; it never reorders it
// (row identity must not depend on the order a user typed). Row count is data (like the
// column count of an expression table); K stays 1.
const std::vector<std::string>& summaryStatCatalog();

}  // namespace dc
