// Node registry unit tests: chain recompute, atomic cycle refusal, close protection,
// stale-result clearing and matrix deletion guards.
// Run under ctest alongside the fixture gate.
#include <cmath>
#include <cstdio>
#include <vector>

#include "expression.h"
#include "matrix_store.h"
#include "nodes.h"

using namespace dc;

static int failures = 0;

#define CHECK(cond)                                                         \
  do {                                                                      \
    if (!(cond)) {                                                          \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond);            \
      ++failures;                                                           \
    }                                                                       \
  } while (0)

static std::vector<double> columnOf(const MatrixStore& store, int64_t matrixId) {
  Matrix m;
  if (!store.snapshot(matrixId, &m) || m.columnCount() == 0) return {};
  return m.column(0).data;
}

int main() {
  MatrixStore store;
  EventBus bus;
  NodeRegistry nodes(&store, &bus);

  // Source matrix [1,2,3,4]
  Column c;
  c.posName = "Pos.1";
  c.data = {1, 2, 3, 4};
  int64_t m1 = store.insert(Matrix({c}));

  PortBinding b1;
  b1.varName = "a";
  b1.mode = "cell";
  b1.sourceMatrixId = m1;
  auto r1 = nodes.create({b1}, "a * 2");
  CHECK(r1.nodeId == 1 && r1.cyclePath.empty());
  nodes.recomputeSubtree(r1.nodeId);
  auto n1 = nodes.get(r1.nodeId);
  CHECK(n1 && n1->state == NodeState::Done);
  CHECK(columnOf(store, n1 ? n1->resultMatrixId() : -1) == std::vector<double>({2, 4, 6, 8}));

  // Chain: node2 = node1.result + 10 → [12,14,16,18]
  PortBinding b2;
  b2.varName = "x";
  b2.mode = "cell";
  b2.sourceMatrixId = n1->resultMatrixId();  // results are matrices too
  auto r2 = nodes.create({b2}, "x + 10");
  CHECK(r2.nodeId == 2 && r2.cyclePath.empty());
  nodes.recomputeSubtree(r2.nodeId);
  auto n2 = nodes.get(r2.nodeId);
  CHECK(n2 && n2->state == NodeState::Done);
  CHECK(columnOf(store, n2 ? n2->resultMatrixId() : -1) == std::vector<double>({12, 14, 16, 18}));

  // Upstream content change must cascade through BOTH dependents in topo order.
  store.replace(m1, [] { Column d; d.posName = "Pos.1"; d.data = {5, 5, 5, 5}; return std::vector<Column>{d}; }());
  nodes.onMatrixChanged(m1);
  CHECK(columnOf(store, n1->resultMatrixId()) == std::vector<double>({10, 10, 10, 10}));
  CHECK(columnOf(store, n2->resultMatrixId()) == std::vector<double>({20, 20, 20, 20}));

  // Cycle refusal is ATOMIC: binding node2 as a source of node1 must register nothing
  // AND must leave node1's previous input binding intact (a rejected PATCH may not
  // break a node that was working).
  PortBinding cycA;
  cycA.varName = "y";
  cycA.sourceNodeId = r2.nodeId;
  PortBinding selfB;
  selfB.varName = "z";
  selfB.sourceMatrixId = m1;
  std::vector<int64_t> path;
  std::vector<PortBinding> newInputs{cycA, selfB};
  bool ok = nodes.update(r1.nodeId, nullptr, &newInputs, &path);
  CHECK(!ok && !path.empty());
  auto kept = nodes.get(r1.nodeId);
  CHECK(kept && kept->inputs.size() == 1);
  CHECK(kept && kept->inputs[0].sourceMatrixId == m1);
  // ...and it still evaluates with the preserved binding.
  nodes.recomputeSubtree(r1.nodeId);
  CHECK(columnOf(store, n1->resultMatrixId()) == std::vector<double>({10, 10, 10, 10}));

  // A node that errors must not keep serving its previous numbers, and its dependents
  // must inherit the error instead of recomputing on stale data.
  const std::string brokenFormula = "NOPE(a)";
  ok = nodes.update(r1.nodeId, &brokenFormula, nullptr, &path);
  CHECK(ok);
  nodes.recomputeSubtree(r1.nodeId);
  auto errored = nodes.get(r1.nodeId);
  CHECK(errored && errored->state == NodeState::Error && errored->errorCode == "unknownFunction");
  CHECK(columnOf(store, n1->resultMatrixId()).empty());
  auto downstream = nodes.get(r2.nodeId);
  CHECK(downstream && downstream->state == NodeState::Error &&
        downstream->errorCode == "upstreamError");
  // Restore a working formula for the remaining checks.
  const std::string goodFormula = "a * 2";
  ok = nodes.update(r1.nodeId, &goodFormula, nullptr, &path);
  CHECK(ok);
  nodes.recomputeSubtree(r1.nodeId);
  CHECK(nodes.get(r2.nodeId) && nodes.get(r2.nodeId)->state == NodeState::Done);

  // Close protection: node2 has no dependents; node1 feeds node2 only through the
  // RESULT MATRIX (m-res1), not a node edge — deleting node2 removes its result matrix.
  bool hadDeps = false;
  CHECK(nodes.remove(r2.nodeId, &hadDeps) && !hadDeps);
  CHECK(nodes.dependentsOf(r1.nodeId).empty());

  // Deleting a stored matrix a node reads must be refused.
  CHECK(!nodes.removeMatrix(m1, &hadDeps) && hadDeps);
  // Deleting a node result matrix directly must be refused too (the node owns it).
  CHECK(!nodes.removeMatrix(n1->resultMatrixId(), &hadDeps) && hadDeps);
  // A matrix nothing reads can be deleted.
  int64_t orphan = store.insert(Matrix({c}));
  CHECK(nodes.removeMatrix(orphan, &hadDeps) && !hadDeps);
  Matrix gone;
  CHECK(!store.snapshot(orphan, &gone));

  // Error state carries the structured code. Both codes match the TS reference:
  // "SQRT(" dies at EOF (unexpectedToken), "(a + 1" at the missing ')'.
  PortBinding bErr;
  bErr.varName = "a";
  bErr.sourceMatrixId = m1;
  auto rErr = nodes.create({bErr}, "SQRT(");
  nodes.recomputeSubtree(rErr.nodeId);
  auto ne = nodes.get(rErr.nodeId);
  CHECK(ne && ne->state == NodeState::Error && ne->errorCode == "unexpectedToken");
  auto rErr2 = nodes.create({bErr}, "(a + 1");
  nodes.recomputeSubtree(rErr2.nodeId);
  auto ne2 = nodes.get(rErr2.nodeId);
  CHECK(ne2 && ne2->state == NodeState::Error && ne2->errorCode == "expectedClose");

  // ── v2 signatures (docs/architecture/port-semantics-v1.md) ──────────────
  // Unknown signature is a structured refusal, never a crash or a silent node.
  auto badSig = nodes.createV2("builtin:nope", {}, Json::object());
  CHECK(badSig.nodeId < 0 && badSig.errorCode == "unknownSignature");

  // builtin:expression-columns: ONE node, ONE wide table, one column per expression.
  // This is what replaces the v1 "one node per formula column" mapping.
  Column two;
  two.posName = "Pos.1";
  two.annotation = "A";
  two.data = {1, 2, 3, 4};
  Column three;
  three.posName = "Pos.2";
  three.annotation = "B";
  three.data = {10, 20, 30, 40};
  int64_t m2 = store.insert(Matrix({two, three}));

  PortBinding src;
  src.portId = "src";
  src.varName = "src";
  src.mode = "matrix";
  src.sourceMatrixId = m2;
  Json params = Json::object();
  Json formulas = Json::array();
  Json f1 = Json::object({{"name", Json("double")}, {"expression", Json("A * 2")}});
  Json f2 = Json::object({{"name", Json("sum")}, {"expression", Json("A + B")}});
  formulas.push(std::move(f1));
  formulas.push(std::move(f2));
  params.set("formulas", std::move(formulas));

  auto sigNode = nodes.createV2("builtin:expression-columns", {src}, params);
  CHECK(sigNode.nodeId > 0 && sigNode.cyclePath.empty() && sigNode.errorCode.empty());
  nodes.recomputeSubtree(sigNode.nodeId);
  auto sn = nodes.get(sigNode.nodeId);
  CHECK(sn && sn->state == NodeState::Done);
  // K is fixed by the signature: one output, however many columns it holds.
  CHECK(sn && sn->resultMatrixIds.size() == 1);
  Matrix sigOut;
  CHECK(store.snapshot(sn ? sn->resultMatrixIds[0] : -1, &sigOut));
  CHECK(sigOut.columnCount() == 2);
  CHECK(sigOut.column(0).data == std::vector<double>({2, 4, 6, 8}));
  CHECK(sigOut.column(1).data == std::vector<double>({11, 22, 33, 44}));
  // Column names ride as annotations so downstream cards see the user's labels.
  CHECK(sigOut.column(0).annotation == "double");
  CHECK(sigOut.column(1).annotation == "sum");

  // Editing one expression re-runs the whole node once (not N times).
  Json formulas2 = Json::array();
  Json g1 = Json::object({{"name", Json("triple")}, {"expression", Json("A * 3")}});
  formulas2.push(std::move(g1));
  Json params2 = Json::object();
  params2.set("formulas", std::move(formulas2));
  CHECK(nodes.updateParams(sigNode.nodeId, params2));
  nodes.recomputeSubtree(sigNode.nodeId);
  Matrix out2;
  CHECK(store.snapshot(sn->resultMatrixIds[0], &out2));
  CHECK(out2.columnCount() == 1);
  CHECK(out2.column(0).data == std::vector<double>({3, 6, 9, 12}));

  // A bad expression inside the signature fails the WHOLE node with the parser's code
  // (the v1 per-column mapping would have failed only that one column's node).
  Json params3 = Json::object();
  Json formulas3 = Json::array();
  Json broken = Json::object({{"name", Json("bad")}, {"expression", Json("NOPE(A)")}});
  formulas3.push(std::move(broken));
  params3.set("formulas", std::move(formulas3));
  CHECK(nodes.updateParams(sigNode.nodeId, params3));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto broken2 = nodes.get(sigNode.nodeId);
  CHECK(broken2 && broken2->state == NodeState::Error &&
        broken2->errorCode == "unknownFunction");
  // …and it must not keep serving the previous numbers.
  Matrix cleared;
  CHECK(store.snapshot(sigNode.nodeId > 0 ? sn->resultMatrixIds[0] : -1, &cleared));
  CHECK(cleared.columnCount() == 0);

  // Missing params is a structured error, not UB.
  CHECK(nodes.updateParams(sigNode.nodeId, Json::object()));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto noParams = nodes.get(sigNode.nodeId);
  CHECK(noParams && noParams->state == NodeState::Error &&
        noParams->errorCode == "badSignatureParams");

  // Result matrices of a signature node are mid-edges: a downstream node can read one.
  Json params4 = Json::object();
  Json formulas4 = Json::array();
  Json ok1 = Json::object({{"name", Json("double")}, {"expression", Json("A * 2")}});
  formulas4.push(std::move(ok1));
  params4.set("formulas", std::move(formulas4));
  CHECK(nodes.updateParams(sigNode.nodeId, params4));
  nodes.recomputeSubtree(sigNode.nodeId);
  PortBinding downstream2;
  downstream2.portId = "up";
  downstream2.varName = "up";
  downstream2.sourceNodeId = sigNode.nodeId;
  downstream2.sourceOutputIndex = 0;
  auto d2 = nodes.create({downstream2}, "up + 1");
  CHECK(d2.nodeId > 0);
  nodes.recomputeSubtree(d2.nodeId);
  auto d2n = nodes.get(d2.nodeId);
  CHECK(d2n && d2n->state == NodeState::Done);
  CHECK(columnOf(store, d2n ? d2n->resultMatrixId() : -1) == std::vector<double>({3, 5, 7, 9}));

  // Column contract: naming the output's columns promises their count. A drift is a
  // structured stop (the data flow ends here), not a silent re-labelling.
  Json params5 = Json::object();
  Json formulas5 = Json::array();
  Json f5a = Json::object({{"name", Json("a")}, {"expression", Json("A * 2")}});
  Json f5b = Json::object({{"name", Json("b")}, {"expression", Json("A + 1")}});
  formulas5.push(std::move(f5a));
  formulas5.push(std::move(f5b));
  params5.set("formulas", std::move(formulas5));
  params5.set("columnContract", Json::object({{"outputId", Json("result")}, {"columns", Json(2)}}));
  CHECK(nodes.updateParams(sigNode.nodeId, params5));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto contracted = nodes.get(sigNode.nodeId);
  CHECK(contracted && contracted->state == NodeState::Done &&
        contracted->resultMatrixIds.size() == 1);

  // …adding a third expression without extending the contract must fail the node.
  Json formulas6 = Json::array();
  Json g6a = Json::object({{"name", Json("a")}, {"expression", Json("A * 2")}});
  Json g6b = Json::object({{"name", Json("b")}, {"expression", Json("A + 1")}});
  Json g6c = Json::object({{"name", Json("c")}, {"expression", Json("A")}});
  formulas6.push(std::move(g6a));
  formulas6.push(std::move(g6b));
  formulas6.push(std::move(g6c));
  Json params6 = Json::object();
  params6.set("formulas", std::move(formulas6));
  params6.set("columnContract", Json::object({{"outputId", Json("result")}, {"columns", Json(2)}}));
  CHECK(nodes.updateParams(sigNode.nodeId, params6));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto violated = nodes.get(sigNode.nodeId);
  CHECK(violated && violated->state == NodeState::Error &&
        violated->errorCode == "columnContractViolation");
  CHECK(violated && violated->errorParams["expected"].asNumber() == 2);
  CHECK(violated && violated->errorParams["actual"].asNumber() == 3);
  // The data flow really stops: the previous result is cleared.
  Matrix stopped;
  CHECK(store.snapshot(violated->resultMatrixId(), &stopped));
  CHECK(stopped.columnCount() == 0);

  // Extending the contract is the explicit way out.
  Json params7 = Json::object();
  Json formulas7 = Json::array();
  Json h1 = Json::object({{"name", Json("a")}, {"expression", Json("A * 2")}});
  Json h2 = Json::object({{"name", Json("b")}, {"expression", Json("A + 1")}});
  Json h3 = Json::object({{"name", Json("c")}, {"expression", Json("A")}});
  formulas7.push(std::move(h1));
  formulas7.push(std::move(h2));
  formulas7.push(std::move(h3));
  params7.set("formulas", std::move(formulas7));
  params7.set("columnContract", Json::object({{"outputId", Json("result")}, {"columns", Json(3)}}));
  CHECK(nodes.updateParams(sigNode.nodeId, params7));
  nodes.recomputeSubtree(sigNode.nodeId);
  auto extended = nodes.get(sigNode.nodeId);
  CHECK(extended && extended->state == NodeState::Done);

  std::printf("%s: node_registry (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
