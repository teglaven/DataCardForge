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
};

// Registry lookups. The returned pointers are valid for the process lifetime.
const FunctionSignature* findSignature(const std::string& id);
std::vector<const FunctionSignature*> allSignatures();

// Well-known built-in ids.
extern const char* const kSigExpressionColumns;
extern const char* const kSigLinearRegression;

}  // namespace dc
