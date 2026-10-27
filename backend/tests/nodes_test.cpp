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

  std::printf("%s: node_registry (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
