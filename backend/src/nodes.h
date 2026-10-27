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
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "expression.h"
#include "json.h"
#include "matrix_store.h"

namespace dc {

enum class NodeState { Dirty, Computing, Done, Error };

const char* nodeName(NodeState s);

// v2 port binding (docs/decisions/2026-10-26-card-schema-v2.md, port-semantics-v1.md).
//
// `portId` is the identity: connections are recognised by it, never by position. It is
// additive so v1 clients that only send `varName` keep working — `varName` stays as the
// declared variable the expression engine resolves against, and `portId` falls back to it.
struct PortBinding {
  std::string portId;               // stable identity; v1 clients may omit it (→ varName)
  std::string varName;              // declared variable name ("a", "A", …)
  std::string mode = "cell";        // "cell" | "matrix" — explicit field, never inferred by callers
  int64_t sourceMatrixId = -1;      // when bound to a stored matrix
  int64_t sourceNodeId = -1;        // when bound to another node's result
  int32_t sourceOutputIndex = 0;    // which output of a K-output node (v1 data is always 0)
};

struct ComputeNode {
  int64_t id = 0;
  std::string kind = "function";    // v1 only function cards live here
  std::string signatureId;          // v2: registry entry; empty ⇒ the v1 `formula` path
  std::vector<PortBinding> inputs;  // ordered; identity is `portId`, this order is display only
  std::string formula;              // v1 single-expression formula
  Json params = Json::object();     // v2 parameters (separate from the dataflow graph)
  // Outputs indexed by the signature's output ordinal. Always ≥ 1 element once created
  // (v1 nodes have exactly one). K is fixed by the signature, never by the data.
  std::vector<int64_t> resultMatrixIds;
  // Output 0, which is also what the legacy protocol field `resultMatrixId` reports.
  int64_t resultMatrixId() const { return resultMatrixIds.empty() ? -1 : resultMatrixIds[0]; }
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
    std::string errorCode;           // structured refusal when nodeId < 0 and no cycle
  };
  CreateResult create(const std::vector<PortBinding>& inputs, const std::string& formula);

  // v2: create from a registry signature. K outputs come from the signature, so the node
  // gets exactly K result matrices at creation (never data-dependent).
  // Unknown signature ⇒ {nodeId=-1, errorCode="unknownSignature"}.
  CreateResult createV2(const std::string& signatureId, const std::vector<PortBinding>& inputs,
                        const Json& params);

  bool update(int64_t nodeId, const std::string* formula,
              const std::vector<PortBinding>* inputs, std::vector<int64_t>* cycleOut);

  // Replace the parameter bag (v2). Marks the node dirty.
  bool updateParams(int64_t nodeId, const Json& params);

  // Refuses with hasDependents semantics left to the caller (close protection is a UI
  // rule; the registry just reports it).
  bool remove(int64_t nodeId, bool* hadDependents);

  // Delete a stored matrix that no node reads and no node owns as a result.
  // Refuses (hadDependents=true) otherwise — the caller maps that to 409.
  bool removeMatrix(int64_t matrixId, bool* hadDependents);

  // Returns a copy: a raw pointer escaped the lock and was a use-after-free window
  // for a concurrent DELETE (see the 2026-10-18 audit).
  std::optional<ComputeNode> get(int64_t nodeId) const;
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
  // Evaluate one node OUTSIDE the registry lock (max-headroom: a slow formula must never
  // freeze every other request — see docs/decisions/2026-10-15-max-headroom-principle.md).
  // The lock is taken in short bursts: publish `computing`, resolve inputs, eval unlocked,
  // then commit the result. Looking the node up by id in each phase also removes the old
  // dangling-pointer window (the node may be deleted between phases).
  void evaluateNode(int64_t nodeId);
  // Transition to Error, clear the stale result, publish the error event.
  // REQUIRES mu_ to be held by the caller.
  void failNodeLocked(int64_t nodeId, const std::string& code, Json params);
  // Resolve every binding to its current columns. The registry lock is taken per binding
  // (to check the upstream state) and released before touching the matrix store, so a
  // large table copy never blocks the writer of an unrelated node.
  bool gatherInputs(const std::vector<PortBinding>& inputs, std::vector<std::string>* names,
                    std::vector<std::vector<double>>* data, size_t* length,
                    std::string* errorCode, std::string* errorName);

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
  // v2: K outputs per node, so the owner is (nodeId, outputIndex).
  std::map<int64_t, std::pair<int64_t, int32_t>> resultOwner_;  // matrixKey(result) -> owner

  // Cycle check over the *dependency* direction, mirroring findDownstreamPath().
  bool wouldCycle(int64_t dependentId, int64_t dependsOnId, std::vector<int64_t>* pathOut) const;
};

}  // namespace dc
