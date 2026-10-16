// Server-side compute nodes: input bindings, formula, result matrix, state machine.
// The dependency graph mirrors web/src/core/DependencyGraph.ts (dedup + cycle refusal)
// with the B-plan addition that a node's N input ports are added ATOMICALLY: if any
// edge would close a loop, no edge is registered (docs/decisions/2026-10-17-backend-owns-compute.md).
#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#include "expression.h"
#include "json.h"
#include "matrix_store.h"

namespace dc {

enum class NodeState { Dirty, Computing, Done, Error };

const char* nodeName(NodeState s);

struct PortBinding {
  std::string varName;              // declared variable name ("a", "A", …)
  std::string mode = "cell";        // "cell" | "matrix" — explicit field, never inferred by callers
  int64_t sourceMatrixId = -1;      // when bound to a stored matrix
  int64_t sourceNodeId = -1;        // when bound to another node's result
};

struct ComputeNode {
  int64_t id = 0;
  std::string kind = "function";    // v1 only function cards live here
  std::vector<PortBinding> inputs;  // ordered; index == port index
  std::string formula;
  int64_t resultMatrixId = -1;
  NodeState state = NodeState::Dirty;
  std::string errorCode;            // structured code when state == Error
  Json errorParams = Json::object();
};

class EventBus {
 public:
  // Monotonic sequence numbers so the client can long-poll `?since=<seq>` safely.
  void publish(Json event);
  // Returns events with seq > since. Blocks up to timeoutMs waiting for new ones.
  std::vector<std::pair<int64_t, Json>> wait(int64_t since, int timeoutMs);

 private:
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::pair<int64_t, Json>> log_;
  int64_t nextSeq_ = 1;
  static constexpr size_t kMaxLog = 4096;
};

class NodeRegistry {
 public:
  NodeRegistry(MatrixStore* store, EventBus* bus) : store_(store), bus_(bus) {}

  // Create a node and register all its edges atomically. On a cycle nothing is created
  // and the offending path is returned (outermost node first, repeats the start node).
  struct CreateResult {
    int64_t nodeId = -1;
    std::vector<int64_t> cyclePath;  // empty when accepted
  };
  CreateResult create(const std::vector<PortBinding>& inputs, const std::string& formula);

  bool update(int64_t nodeId, const std::string* formula,
              const std::vector<PortBinding>* inputs, std::vector<int64_t>* cycleOut);

  // Refuses with hasDependents semantics left to the caller (close protection is a UI
  // rule; the registry just reports it).
  bool remove(int64_t nodeId, bool* hadDependents);

  const ComputeNode* get(int64_t nodeId) const;
  std::vector<int64_t> dependentsOf(int64_t nodeId) const;

  // Recompute `nodeId` now, then transitively refresh every dependent in topological
  // order (coalesced: one change triggers each downstream node at most once).
  // Publishes computing/done/error events for every touched node.
  void recomputeSubtree(int64_t nodeId);

  // Called when a stored matrix changed (file switch / edit): mark + recompute all
  // nodes reading it, transitively.
  void onMatrixChanged(int64_t matrixId);

  std::vector<int64_t> allNodeIds() const;

  // Graph keys are namespaced: node ids are positive; matrix sources are -(matrixId+1).
  // Node and matrix counters both start at 1, so raw ids would collide (smoke test found
  // a fresh node "depending on itself" because its own id equalled the bound matrix id).
  static int64_t matrixKey(int64_t matrixId) { return -(matrixId + 1); }
  static int64_t sourceKey(const PortBinding& b) {
    return b.sourceNodeId >= 0 ? b.sourceNodeId : matrixKey(b.sourceMatrixId);
  }

 private:
  void evaluateNode(ComputeNode* node);
  // Resolve one binding to its current columns. Throws ExpressionError-compatible
  // failures via std::runtime_error subclasses handled locally.
  bool gatherInputs(const ComputeNode& node, std::vector<std::string>* names,
                    std::vector<std::vector<double>>* data, size_t* length,
                    ExpressionError* err);

  mutable std::mutex mu_;
  MatrixStore* store_;
  EventBus* bus_;
  std::map<int64_t, ComputeNode> nodes_;
  int64_t nextNodeId_ = 1;
  // dependsOn -> dependents (both directions available cheaply).
  std::map<int64_t, std::set<int64_t>> dependents_;   // matrixOrNodeId -> nodeIds
  std::map<int64_t, std::set<int64_t>> dependencies_; // nodeId -> matrixOrNodeIds
  // A node's result matrix is NOT an ordinary sink: it sits ON TOP of the node that
  // produced it. Without this map, chains through results (node1 -> res1 -> node2)
  // are invisible to both cascade BFS and cycle detection (found by unit test).
  std::map<int64_t, int64_t> resultOwner_;            // matrixKey(result) -> nodeId

  // Cycle check over the *dependency* direction, mirroring findDownstreamPath().
  bool wouldCycle(int64_t dependentId, int64_t dependsOnId, std::vector<int64_t>* pathOut) const;
};

}  // namespace dc
