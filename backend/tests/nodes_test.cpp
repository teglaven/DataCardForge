// Node registry unit tests: chain recompute, atomic cycle refusal, close protection.
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
  const ComputeNode* n1 = nodes.get(r1.nodeId);
  CHECK(n1 && n1->state == NodeState::Done);
  const Matrix* res1 = store.get(n1->resultMatrixId);
  CHECK(res1 && res1->column(0).data == std::vector<double>({2, 4, 6, 8}));

  // Chain: node2 = node1.result + 10 → [12,14,16,18]
  PortBinding b2;
  b2.varName = "x";
  b2.mode = "cell";
  b2.sourceMatrixId = n1->resultMatrixId;  // results are matrices too
  auto r2 = nodes.create({b2}, "x + 10");
  CHECK(r2.nodeId == 2 && r2.cyclePath.empty());
  nodes.recomputeSubtree(r2.nodeId);
  const ComputeNode* n2 = nodes.get(r2.nodeId);
  CHECK(n2 && n2->state == NodeState::Done);
  const Matrix* res2 = store.get(n2->resultMatrixId);
  CHECK(res2 && res2->column(0).data == std::vector<double>({12, 14, 16, 18}));

  // Upstream content change must cascade through BOTH dependents in topo order.
  store.replace(m1, [] { Column d; d.posName = "Pos.1"; d.data = {5, 5, 5, 5}; return std::vector<Column>{d}; }());
  nodes.onMatrixChanged(m1);
  CHECK(store.get(n1->resultMatrixId)->column(0).data == std::vector<double>({10, 10, 10, 10}));
  CHECK(store.get(n2->resultMatrixId)->column(0).data == std::vector<double>({20, 20, 20, 20}));

  // Cycle refusal is ATOMIC for multi-port edges: binding node2 as a source of node1
  // (plus a fresh unbound port) must register nothing on rejection.
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
  // And the rejected update left node1 without inputs (documented rollback behavior),
  // never with a half-registered edge set.
  CHECK(nodes.get(r1.nodeId)->inputs.empty());

  // Close protection: node2 has no dependents; node1 feeds node2 only through the
  // RESULT MATRIX (m-res1), not a node edge — deleting node1 removes its result matrix.
  bool hadDeps = false;
  CHECK(nodes.remove(r2.nodeId, &hadDeps) && !hadDeps);
  CHECK(nodes.dependentsOf(r1.nodeId).empty());

  // Error state carries the structured code. Both codes match the TS reference:
  // "SQRT(" dies at EOF (unexpectedToken), "(a + 1" at the missing ')'.
  PortBinding bErr;
  bErr.varName = "a";
  bErr.sourceMatrixId = m1;
  auto rErr = nodes.create({bErr}, "SQRT(");
  nodes.recomputeSubtree(rErr.nodeId);
  const ComputeNode* ne = nodes.get(rErr.nodeId);
  CHECK(ne && ne->state == NodeState::Error && ne->errorCode == "unexpectedToken");
  auto rErr2 = nodes.create({bErr}, "(a + 1");
  nodes.recomputeSubtree(rErr2.nodeId);
  const ComputeNode* ne2 = nodes.get(rErr2.nodeId);
  CHECK(ne2 && ne2->state == NodeState::Error && ne2->errorCode == "expectedClose");

  std::printf("%s: node_registry (%d failures)\n", failures == 0 ? "PASS" : "FAILED", failures);
  return failures == 0 ? 0 : 1;
}
