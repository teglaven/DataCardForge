// Card-layer differential fixture runner (C++ side).
//
// Reads web/tests/fixtures/cards/*.json — the SAME file the TypeScript side parses in
// web/tests/cardFixtures.test.ts — builds each described card through NodeRegistry and
// compares what it computes against the fixture's `expect` / `expectError`.
//
// This is the referee the schema-v2 decision demanded ("卡片层夹具——必须有裁判"): before it
// existed, the card→port mapping had three incompatible definitions (frontend model,
// frontend DTO, backend PortBinding) and nothing that could tell them apart. The TS side
// judges how a card becomes port bindings; this side judges what those bindings compute.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "json.h"
#include "matrix_store.h"
#include "nodes.h"

using namespace dc;

namespace {

double revive(const Json& v, bool* ok) {
  *ok = true;
  if (v.isNumber()) return v.asNumber();
  if (v.isString()) {
    const std::string& s = v.asString();
    if (s == "NaN") return NAN;
    if (s == "Infinity") return INFINITY;
    if (s == "-Infinity") return -INFINITY;
  }
  *ok = false;
  return 0;
}

bool sameNumber(double a, double b) {
  if (std::isnan(a) && std::isnan(b)) return true;
  if (!std::isfinite(a) || !std::isfinite(b)) return a == b;
  return a == b;
}

// Fixture matrix ids are wire-level ids, so they are allocated in the order they appear and
// kept in a map: an expression card binds the matrix named by the fixture, not by position.
struct Fixture {
  const std::string name;
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes{&store, &bus};
  std::map<int64_t, int64_t> matrixIds;  // fixture id -> store id

  explicit Fixture(std::string fixtureName) : name(std::move(fixtureName)) {}
};

bool buildMatrices(const Json& c, Fixture* f, std::string* err) {
  for (const auto& m : c["matrices"].items()) {
    std::vector<Column> columns;
    const auto& cols = m["columns"].items();
    for (const auto& col : cols) {
      Column column;
      column.posName = col["posName"].isString() ? col["posName"].asString() : "Pos.1";
      column.annotation = col["annotation"].isString() ? col["annotation"].asString() : "";
      for (const auto& v : col["data"].items()) {
        bool ok = false;
        const double value = revive(v, &ok);
        if (!ok) {
          *err = "bad cell value";
          return false;
        }
        column.data.push_back(value);
      }
      columns.push_back(std::move(column));
    }
    const int64_t fixtureId = static_cast<int64_t>(m["id"].asNumber());
    Matrix matrix(std::move(columns));
    f->matrixIds[fixtureId] = f->store.insert(std::move(matrix));
  }
  return true;
}

/** Build the node the fixture's card describes; returns the node id or -1 with *err set. */
int64_t buildCard(const Json& c, Fixture* f, std::string* err) {
  const Json& card = c["card"];
  const std::string signatureId = card["signatureId"].isString() ? card["signatureId"].asString() : "";
  std::vector<PortBinding> inputs;
  for (const auto& input : card["inputs"].items()) {
    PortBinding binding;
    binding.portId = input["portId"].isString() ? input["portId"].asString() : "";
    binding.varName = binding.portId;
    binding.mode = "matrix";
    const Json& target = input["target"];
    const int64_t fixtureMatrixId = static_cast<int64_t>(target["matrixId"].asNumber());
    auto it = f->matrixIds.find(fixtureMatrixId);
    if (it == f->matrixIds.end()) {
      *err = "input references an unknown matrix";
      return -1;
    }
    binding.sourceMatrixId = it->second;
    inputs.push_back(std::move(binding));
  }
  const Json params = card["params"].isObject() ? card["params"] : Json::object();
  auto created = f->nodes.createV2(signatureId, inputs, params);
  if (!created.errorCode.empty()) {
    *err = created.errorCode;
    return -1;
  }
  if (!created.cyclePath.empty()) {
    *err = "cycle";
    return -1;
  }
  f->nodes.recomputeSubtree(created.nodeId);
  // A signature with `explicitCompute` (builtin:summary) is deliberately left dirty here:
  // whether the fixture computes is the case's own `trigger` decision, never the runner's
  // guess. Guessing would quietly turn "创建后不算" into an untested claim.
  return created.nodeId;
}

// The state the case says the card must be in right after creation, before any trigger.
// This is how the lazy contract gets a referee at the card layer rather than only in the
// integration test (which needs a live backend).
bool checkAfterCreate(const Json& c, Fixture* f, int64_t nodeId) {
  const Json& want = c["afterCreate"];
  if (!want.isObject()) return true;
  const auto node = f->nodes.get(nodeId);
  if (!node) {
    std::printf("FAIL %-40s node vanished\n", f->name.c_str());
    return false;
  }
  if (want["state"].isString()) {
    const std::string wantState = want["state"].asString();
    if (wantState != nodeName(node->state)) {
      std::printf("FAIL %-40s after create: state %s, want %s\n", f->name.c_str(),
                  nodeName(node->state), wantState.c_str());
      return false;
    }
  }
  if (want["reason"].isString()) {
    const std::string wantReason = want["reason"].asString();
    if (wantReason != dirtyReasonName(node->dirtyReason)) {
      std::printf("FAIL %-40s after create: reason %s, want %s\n", f->name.c_str(),
                  dirtyReasonName(node->dirtyReason), wantReason.c_str());
      return false;
    }
  }
  // A "not requested" node must not be hiding numbers behind the label either.
  const Json* emptyFlag = want.find("empty");
  if (emptyFlag && emptyFlag->kind() == Json::Kind::Bool && emptyFlag->asBool()) {
    for (int64_t resultId : node->resultMatrixIds) {
      Matrix m;
      if (f->store.snapshot(resultId, &m) && m.columnCount() != 0) {
        std::printf("FAIL %-40s after create: expected an empty result, got %zu columns\n",
                    f->name.c_str(), m.columnCount());
        return false;
      }
    }
  }
  return true;
}

bool checkOutputs(const Json& c, Fixture* f, int64_t nodeId) {
  const auto node = f->nodes.get(nodeId);
  if (!node) {
    std::printf("FAIL %-40s node vanished\n", f->name.c_str());
    return false;
  }
  const auto expected = c["expect"]["outputs"].items();
  if (node->resultMatrixIds.size() != expected.size()) {
    std::printf("FAIL %-40s output count %zu != %zu\n", f->name.c_str(),
                node->resultMatrixIds.size(), expected.size());
    return false;
  }
  for (size_t o = 0; o < expected.size(); ++o) {
    Matrix produced;
    if (!f->store.snapshot(node->resultMatrixIds[o], &produced)) {
      std::printf("FAIL %-40s output %zu missing\n", f->name.c_str(), o);
      return false;
    }
    const auto& wantColumns = expected[o]["columns"].items();
    if (produced.columnCount() != wantColumns.size()) {
      std::printf("FAIL %-40s output %zu has %zu columns, want %zu\n", f->name.c_str(), o,
                  produced.columnCount(), wantColumns.size());
      return false;
    }
    for (size_t col = 0; col < wantColumns.size(); ++col) {
      const Json& want = wantColumns[col];
      // The column NAME must reach the result as its annotation: that is how a renamed or
      // expression-named column becomes visible to every downstream card.
      const std::string wantName = want["name"].asString();
      if (produced.column(col).annotation != wantName) {
        std::printf("FAIL %-40s output %zu column %zu named '%s', want '%s'\n", f->name.c_str(),
                    o, col, produced.column(col).annotation.c_str(), wantName.c_str());
        return false;
      }
      const auto& data = want["data"].items();
      if (produced.column(col).data.size() != data.size()) {
        std::printf("FAIL %-40s output %zu column %zu has %zu rows, want %zu\n", f->name.c_str(),
                    o, col, produced.column(col).data.size(), data.size());
        return false;
      }
      for (size_t r = 0; r < data.size(); ++r) {
        bool ok = false;
        const double wantValue = revive(data[r], &ok);
        if (!ok || !sameNumber(produced.column(col).data[r], wantValue)) {
          std::printf("FAIL %-40s output %zu column %zu row %zu: got %.17g want %.17g\n",
                      f->name.c_str(), o, col, r, produced.column(col).data[r], wantValue);
          return false;
        }
      }
    }
  }
  return true;
}

bool checkError(const Json& c, Fixture* f, int64_t nodeId) {
  const auto node = f->nodes.get(nodeId);
  if (!node) {
    std::printf("FAIL %-40s node vanished\n", f->name.c_str());
    return false;
  }
  const Json& want = c["expectError"];
  const std::string wantCode = want["code"].asString();
  if (node->state != NodeState::Error) {
    std::printf("FAIL %-40s expected error %s, state is %s\n", f->name.c_str(), wantCode.c_str(),
                nodeName(node->state));
    return false;
  }
  if (node->errorCode != wantCode) {
    std::printf("FAIL %-40s error code %s != %s\n", f->name.c_str(), node->errorCode.c_str(),
                wantCode.c_str());
    return false;
  }
  // Structured params are part of the contract (the UI renders from them).
  for (const auto& kv : want["params"].members()) {
    const Json* got = node->errorParams.find(kv.first);
    if (!got || !got->isNumber() || got->asNumber() != kv.second.asNumber()) {
      std::printf("FAIL %-40s error param '%s' missing or different\n", f->name.c_str(),
                  kv.first.c_str());
      return false;
    }
  }
  // An erroring node must not keep serving the previous numbers.
  for (int64_t resultId : node->resultMatrixIds) {
    Matrix stale;
    if (f->store.snapshot(resultId, &stale) && stale.columnCount() != 0) {
      std::printf("FAIL %-40s error node kept %zu stale columns\n", f->name.c_str(),
                  stale.columnCount());
      return false;
    }
  }
  return true;
}

int runFile(const std::string& path) {
  std::ifstream in(path);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", path.c_str());
    return 2;
  }
  std::stringstream ss;
  ss << in.rdbuf();
  Json root;
  std::string err;
  if (!Json::parse(ss.str(), &root, &err)) {
    std::fprintf(stderr, "bad JSON in %s: %s\n", path.c_str(), err.c_str());
    return 2;
  }

  int passed = 0;
  int failed = 0;
  for (const auto& c : root["cases"].items()) {
    const std::string name = c["name"].asString();
    Fixture fixture(name);
    bool ok = true;

    if (!buildMatrices(c, &fixture, &err)) {
      std::printf("FAIL %-40s %s\n", name.c_str(), err.c_str());
      ok = false;
    } else {
      std::string buildErr;
      const int64_t nodeId = buildCard(c, &fixture, &buildErr);
      if (nodeId < 0) {
        std::printf("FAIL %-40s could not build the card: %s\n", name.c_str(), buildErr.c_str());
        ok = false;
      } else {
        bool statusOk = checkAfterCreate(c, &fixture, nodeId);
        // The explicit trigger is part of the case, not of the card: a fixture that forgot
        // it would test the "not computed" state, which is exactly what `afterCreate` says.
        if (c["trigger"].isString() && c["trigger"].asString() == "compute") {
          fixture.nodes.computeNow(nodeId);
        }
        if (!statusOk) {
          ok = false;
        } else if (c["expectError"].isObject()) {
          ok = checkError(c, &fixture, nodeId);
        } else if (c["expect"].isObject()) {
          ok = checkOutputs(c, &fixture, nodeId);
        } else {
          std::printf("FAIL %-40s neither expect nor expectError\n", name.c_str());
          ok = false;
        }
      }
    }

    if (ok) ++passed;
    else ++failed;
  }
  std::printf("%s: %d passed, %d failed (%s)\n", failed == 0 ? "PASS" : "FAILED", passed, failed,
              path.c_str());
  return failed == 0 ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: dc_card_fixture_run <fixture.json> [...]\n");
    return 2;
  }
  int worst = 0;
  for (int i = 1; i < argc; ++i) worst = std::max(worst, runFile(argv[i]));
  return worst;
}
