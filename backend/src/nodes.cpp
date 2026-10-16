#include "nodes.h"

#include <algorithm>
#include <condition_variable>
#include <queue>

#include "expression.h"

namespace dc {

const char* nodeName(NodeState s) {
  switch (s) {
    case NodeState::Dirty: return "dirty";
    case NodeState::Computing: return "computing";
    case NodeState::Done: return "done";
    case NodeState::Error: return "error";
  }
  return "dirty";
}

void EventBus::publish(Json event) {
  std::lock_guard<std::mutex> lock(mu_);
  log_.emplace_back(nextSeq_++, std::move(event));
  if (log_.size() > kMaxLog) log_.pop_front();
  cv_.notify_all();
}

std::vector<std::pair<int64_t, Json>> EventBus::wait(int64_t since, int timeoutMs) {
  std::unique_lock<std::mutex> lock(mu_);
  cv_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
               [&] { return log_.empty() ? false : log_.back().first > since; });
  std::vector<std::pair<int64_t, Json>> out;
  for (const auto& e : log_)
    if (e.first > since) out.push_back(e);
  return out;
}

bool NodeRegistry::wouldCycle(int64_t dependentId, int64_t dependsOnId,
                              std::vector<int64_t>* pathOut) const {
  // If `dependsOnId` already sits on top of `dependentId` (transitively through the
  // dependency direction), adding dependentId -> dependsOnId closes a loop.
  // BFS from dependsOnId over upstream sources, looking for dependentId.
  if (dependentId == dependsOnId) {
    if (pathOut) pathOut->assign({dependentId, dependentId});
    return true;
  }
  std::map<int64_t, int64_t> previous;  // node -> parent on the found path
  std::queue<int64_t> queue;
  std::set<int64_t> seen{dependsOnId};
  queue.push(dependsOnId);
  while (!queue.empty()) {
    int64_t current = queue.front();
    queue.pop();
    // Upstream of `current`: its input bindings' source keys (matrices are sinks),
    // plus — when `current` is a result matrix — the node that produced it.
    std::vector<int64_t> ups;
    auto dit = dependencies_.find(current);
    if (dit != dependencies_.end()) ups.assign(dit->second.begin(), dit->second.end());
    auto ownerIt = resultOwner_.find(current);
    if (ownerIt != resultOwner_.end() &&
        std::find(ups.begin(), ups.end(), ownerIt->second) == ups.end())
      ups.push_back(ownerIt->second);
    for (int64_t up : ups) {
      if (seen.count(up)) continue;
      seen.insert(up);
      previous[up] = current;
      if (up == dependentId) {
        if (pathOut) {
          std::vector<int64_t> path{up};
          int64_t cursor = up;
          while (cursor != dependsOnId) {
            cursor = previous[cursor];
            path.push_back(cursor);
          }
          std::reverse(path.begin(), path.end());
          path.push_back(dependsOnId);  // ring: start and end at the same node
          *pathOut = path;
        }
        return true;
      }
      queue.push(up);
    }
  }
  return false;
}

NodeRegistry::CreateResult NodeRegistry::create(const std::vector<PortBinding>& inputs,
                                                const std::string& formula) {
  std::lock_guard<std::mutex> lock(mu_);
  CreateResult result;

  // Atomic edge check: every source must exist and no edge may close a loop.
  int64_t tentativeId = nextNodeId_;
  for (const auto& b : inputs) {
    if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
    std::vector<int64_t> path;
    if (wouldCycle(tentativeId, sourceKey(b), &path)) {
      result.cyclePath = path;
      return result;
    }
  }

  ComputeNode node;
  node.id = nextNodeId_++;
  node.inputs = inputs;
  node.formula = formula;
  node.resultMatrixId = store_->insert(Matrix{});
  int64_t nodeId = node.id;
  resultOwner_[matrixKey(node.resultMatrixId)] = nodeId;
  for (const auto& b : node.inputs) {
    if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
    int64_t key = sourceKey(b);
    dependents_[key].insert(nodeId);
    dependencies_[nodeId].insert(key);
  }
  nodes_.emplace(nodeId, std::move(node));
  result.nodeId = nodeId;
  return result;
}

bool NodeRegistry::update(int64_t nodeId, const std::string* formula,
                          const std::vector<PortBinding>* inputs,
                          std::vector<int64_t>* cycleOut) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return false;

  if (inputs) {
    // Re-register edges atomically: check all new sources against the graph *without*
    // this node's old edges first.
    for (auto& d : dependencies_[nodeId]) dependents_[d].erase(nodeId);
    dependencies_[nodeId].clear();
    std::vector<int64_t> path;
    for (const auto& b : *inputs) {
      if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
      if (wouldCycle(nodeId, sourceKey(b), &path)) {
        if (cycleOut) *cycleOut = path;
        // Roll back: restore nothing (old edges already dropped). The node keeps the
        // NEW inputs only when accepted; here we reject and leave inputs unbound.
        it->second.inputs.clear();
        it->second.state = NodeState::Dirty;
        return false;
      }
    }
    it->second.inputs = *inputs;
    for (const auto& b : it->second.inputs) {
      if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
      int64_t key = sourceKey(b);
      dependents_[key].insert(nodeId);
      dependencies_[nodeId].insert(key);
    }
  }
  if (formula) it->second.formula = *formula;
  it->second.state = NodeState::Dirty;
  return true;
}

bool NodeRegistry::remove(int64_t nodeId, bool* hadDependents) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return false;
  auto depIt = dependents_.find(nodeId);
  if (depIt != dependents_.end() && !depIt->second.empty()) {
    if (hadDependents) *hadDependents = true;
    return false;
  }
  if (hadDependents) *hadDependents = false;
  for (auto& d : dependencies_[nodeId]) dependents_[d].erase(nodeId);
  dependencies_.erase(nodeId);
  dependents_.erase(nodeId);
  int64_t resultId = it->second.resultMatrixId;
  resultOwner_.erase(matrixKey(resultId));
  nodes_.erase(it);
  store_->remove(resultId);
  return true;
}

const ComputeNode* NodeRegistry::get(int64_t nodeId) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  return it == nodes_.end() ? nullptr : &it->second;
}

std::vector<int64_t> NodeRegistry::dependentsOf(int64_t nodeId) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = dependents_.find(nodeId);
  if (it == dependents_.end()) return {};
  return std::vector<int64_t>(it->second.begin(), it->second.end());
}

std::vector<int64_t> NodeRegistry::allNodeIds() const {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<int64_t> ids;
  for (const auto& kv : nodes_) ids.push_back(kv.first);
  return ids;
}

bool NodeRegistry::gatherInputs(const ComputeNode& node, std::vector<std::string>* names,
                                std::vector<std::vector<double>>* data, size_t* length,
                                ExpressionError* err) {
  names->clear();
  data->clear();
  *length = 0;
  // Port semantics (B-plan v1): a port binds a whole table to a declared variable.
  // Every column stays addressable under its natural label; a single-column table is
  // additionally aliased to the declared varName so `a + 1` reads naturally. Multi-
  // column tables get per-column slicing from the deferred conditional-filter card.
  for (const auto& b : node.inputs) {
    const Matrix* m = nullptr;
    if (b.sourceNodeId >= 0) {
      auto nit = nodes_.find(b.sourceNodeId);
      if (nit != nodes_.end()) m = store_->get(nit->second.resultMatrixId);
    } else if (b.sourceMatrixId >= 0) {
      m = store_->get(b.sourceMatrixId);
    }
    if (!m || m->columnCount() == 0) {
      if (err) *err = ExpressionError("unbound input '" + b.varName + "'", -1, "unknownColumn");
      return false;
    }
    for (const auto& col : m->columns()) {
      names->push_back(Matrix::label(col));
      data->push_back(col.data);
    }
    // The alias must keep names.size() == data.size(): the engine indexes data by the
    // resolved name index (a mismatched pair reads out of bounds — found by smoke test).
    if (m->columnCount() == 1) {
      names->push_back(b.varName);
      data->push_back(m->column(0).data);
    }
    *length = std::max(*length, m->rowCount());
  }
  return true;
}

void NodeRegistry::evaluateNode(ComputeNode* node) {
  node->state = NodeState::Computing;
  bus_->publish(Json::object({{"nodeId", Json(static_cast<int64_t>(node->id))},
                              {"state", Json(std::string(nodeName(node->state)))}}));
  std::vector<std::string> names;
  std::vector<std::vector<double>> data;
  size_t length = 0;
  ExpressionError gatherErr("", -1, "");
  if (!gatherInputs(*node, &names, &data, &length, &gatherErr)) {
    node->state = NodeState::Error;
    node->errorCode = gatherErr.code;
    node->errorParams = Json::object({{"name", Json(gatherErr.what())}});
    bus_->publish(Json::object({{"nodeId", Json(static_cast<int64_t>(node->id))},
                                {"state", Json(std::string("error"))},
                                {"code", Json(node->errorCode)},
                                {"params", node->errorParams}}));
    return;
  }
  try {
    std::vector<double> values = ExprEngine::evaluate(node->formula, names, data,
                                                      length == 0 ? 1 : length);
    Column out;
    out.posName = "Pos.1";
    out.annotation = "";
    out.data = std::move(values);
    store_->replace(node->resultMatrixId, {out});
    node->state = NodeState::Done;
    node->errorCode.clear();
    bus_->publish(Json::object({{"nodeId", Json(static_cast<int64_t>(node->id))},
                                {"state", Json(std::string("done"))},
                                {"matrixId", Json(node->resultMatrixId)}}));
  } catch (const ExpressionError& e) {
    node->state = NodeState::Error;
    node->errorCode = e.code;
    node->errorParams = Json::object({{"position", Json(e.position)}});
    bus_->publish(Json::object({{"nodeId", Json(static_cast<int64_t>(node->id))},
                                {"state", Json(std::string("error"))},
                                {"code", Json(e.code)},
                                {"params", node->errorParams}}));
  }
}

void NodeRegistry::recomputeSubtree(int64_t nodeId) {
  // Collect the transitive dependents first (under the lock), then evaluate in
  // topological order outside the registry lock sections that call back in.
  std::vector<int64_t> order;
  {
    std::lock_guard<std::mutex> lock(mu_);
    std::set<int64_t> visited;
    std::queue<int64_t> q;
    q.push(nodeId);
    while (!q.empty()) {
      int64_t cur = q.front();
      q.pop();
      if (!visited.insert(cur).second) continue;
      order.push_back(cur);
      auto it = dependents_.find(cur);
      if (it != dependents_.end())
        for (int64_t d : it->second) q.push(d);
      // The node's result matrix is a mid-edge: whoever binds it depends on this node.
      auto nit = nodes_.find(cur);
      if (nit != nodes_.end()) {
        auto rit = dependents_.find(matrixKey(nit->second.resultMatrixId));
        if (rit != dependents_.end())
          for (int64_t d : rit->second) q.push(d);
      }
    }
  }
  // Topo order via BFS above is already dependency-first because edges point
  // source->dependent; evaluate each node in turn.
  for (int64_t id : order) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = nodes_.find(id);
    if (it == nodes_.end()) continue;
    evaluateNode(&it->second);
  }
}

void NodeRegistry::onMatrixChanged(int64_t matrixId) {
  std::vector<int64_t> direct;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = dependents_.find(matrixKey(matrixId));
    if (it == dependents_.end()) return;
    direct.assign(it->second.begin(), it->second.end());
  }
  for (int64_t id : direct) recomputeSubtree(id);
}

}  // namespace dc
