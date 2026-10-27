#include "nodes.h"

#include <algorithm>
#include <condition_variable>
#include <queue>

#include "expression.h"
#include "matrix_value.h"  // ShapeError (matrix-mode failures)
#include "signature.h"

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
        std::find(ups.begin(), ups.end(), ownerIt->second.first) == ups.end())
      ups.push_back(ownerIt->second.first);
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

namespace {

// Shared creation body. REQUIRES the registry lock to be held (create/createV2 take it).
// `nOutputs` comes from the signature (K), never from the data.
NodeRegistry::CreateResult createLocked(std::map<int64_t, ComputeNode>* nodes,
                                        std::map<int64_t, std::set<int64_t>>* dependents,
                                        std::map<int64_t, std::set<int64_t>>* dependencies,
                                        std::map<int64_t, std::pair<int64_t, int32_t>>* owners,
                                        MatrixStore* store, int64_t nodeId,
                                        const std::string& signatureId,
                                        const std::vector<PortBinding>& inputs,
                                        const std::string& formula, const Json& params,
                                        size_t nOutputs) {
  NodeRegistry::CreateResult result;
  ComputeNode node;
  node.id = nodeId;
  node.signatureId = signatureId;
  // v2: `portId` is the identity. A v1 client that only sends `varName` keeps working —
  // the identity then falls back to the declared variable name.
  for (PortBinding b : inputs) {
    if (b.portId.empty()) b.portId = b.varName;
    node.inputs.push_back(std::move(b));
  }
  node.formula = formula;
  node.params = params;
  // K is a signature property, never data-dependent.
  for (size_t i = 0; i < nOutputs; ++i) node.resultMatrixIds.push_back(store->insert(Matrix{}));
  for (size_t i = 0; i < node.resultMatrixIds.size(); ++i)
    (*owners)[NodeRegistry::matrixKey(node.resultMatrixIds[i])] = {nodeId, static_cast<int32_t>(i)};
  for (const auto& b : node.inputs) {
    if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
    int64_t key = NodeRegistry::sourceKey(b);
    (*dependents)[key].insert(nodeId);
    (*dependencies)[nodeId].insert(key);
  }
  nodes->emplace(nodeId, std::move(node));
  result.nodeId = nodeId;
  return result;
}

}  // namespace

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

  int64_t nodeId = nextNodeId_++;
  return createLocked(&nodes_, &dependents_, &dependencies_, &resultOwner_, store_, nodeId, "",
                      inputs, formula, Json::object(), 1);
}

NodeRegistry::CreateResult NodeRegistry::createV2(const std::string& signatureId,
                                                  const std::vector<PortBinding>& inputs,
                                                  const Json& params) {
  std::lock_guard<std::mutex> lock(mu_);
  const FunctionSignature* sig = findSignature(signatureId);
  if (!sig) {
    CreateResult refused;
    refused.errorCode = "unknownSignature";
    return refused;
  }

  // Atomic edge check (same rule as v1): every source must exist, no edge may close a loop.
  int64_t tentativeId = nextNodeId_;
  for (const auto& b : inputs) {
    if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
    std::vector<int64_t> path;
    if (wouldCycle(tentativeId, sourceKey(b), &path)) {
      CreateResult result;
      result.cyclePath = path;
      return result;
    }
  }

  int64_t nodeId = nextNodeId_++;
  return createLocked(&nodes_, &dependents_, &dependencies_, &resultOwner_, store_, nodeId,
                      signatureId, inputs, "", params, sig->outputs.size());
}

bool NodeRegistry::updateParams(int64_t nodeId, const Json& params) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return false;
  it->second.params = params;
  it->second.state = NodeState::Dirty;
  return true;
}

bool NodeRegistry::update(int64_t nodeId, const std::string* formula,
                          const std::vector<PortBinding>* inputs,
                          std::vector<int64_t>* cycleOut) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return false;

  if (inputs) {
    // Validate every new edge FIRST, against the still-unchanged graph. wouldCycle()
    // walks the dependency map upwards from the source and never consults this node's
    // own inputs, so the old edge set does not have to be torn down to run the check —
    // and it must not be: a rejected PATCH has to leave the previous bindings intact
    // (audit finding: the old code dropped them before validating, so a 409 cycle
    // silently broke a node that had been working).
    std::vector<int64_t> path;
    for (const auto& b : *inputs) {
      if (b.sourceNodeId < 0 && b.sourceMatrixId < 0) continue;
      if (wouldCycle(nodeId, sourceKey(b), &path)) {
        if (cycleOut) *cycleOut = path;
        return false;  // atomic refusal: no edge added, none removed
      }
    }
    // Commit only after the whole batch is known to be acceptable.
    for (auto& d : dependencies_[nodeId]) dependents_[d].erase(nodeId);
    dependencies_[nodeId].clear();
    it->second.inputs.clear();
    for (PortBinding b : *inputs) {
      if (b.portId.empty()) b.portId = b.varName;
      it->second.inputs.push_back(std::move(b));
    }
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
  // K outputs: release every result matrix this node owns.
  std::vector<int64_t> results = it->second.resultMatrixIds;
  for (int64_t resultId : results) resultOwner_.erase(matrixKey(resultId));
  nodes_.erase(it);
  for (int64_t resultId : results) store_->remove(resultId);
  return true;
}

std::optional<ComputeNode> NodeRegistry::get(int64_t nodeId) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return std::nullopt;
  return it->second;
}

bool NodeRegistry::removeMatrix(int64_t matrixId, bool* hadDependents) {
  std::lock_guard<std::mutex> lock(mu_);
  const int64_t key = matrixKey(matrixId);
  auto dit = dependents_.find(key);
  if (dit != dependents_.end() && !dit->second.empty()) {
    if (hadDependents) *hadDependents = true;
    return false;
  }
  if (resultOwner_.find(key) != resultOwner_.end()) {
    // It is some node's output matrix; deleting it would orphan the producer.
    if (hadDependents) *hadDependents = true;
    return false;
  }
  dependents_.erase(key);
  if (hadDependents) *hadDependents = false;
  return store_->remove(matrixId);
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

bool NodeRegistry::gatherInputs(const std::vector<PortBinding>& bindings,
                                std::vector<std::string>* names,
                                std::vector<std::vector<double>>* data, size_t* length,
                                std::string* errorCode, std::string* errorName) {
  names->clear();
  data->clear();
  *length = 0;
  // Port semantics (B-plan v1): a port binds a whole table to a declared variable.
  // Every column stays addressable under its natural label; a single-column table is
  // additionally aliased to the declared varName so `a + 1` reads naturally. Multi-
  // column tables get per-column slicing from the deferred conditional-filter card.
  //
  // The registry lock is taken per binding and released before touching the matrix store:
  // copying a huge table must not block unrelated node writers (max-headroom). Lock order
  // is always registry → store, never the reverse.
  for (const auto& b : bindings) {
    int64_t matrixId = -1;
    {
      std::lock_guard<std::mutex> lock(mu_);
      if (b.sourceNodeId >= 0) {
        auto nit = nodes_.find(b.sourceNodeId);
        if (nit == nodes_.end()) {
          *errorCode = "unknownColumn";
          *errorName = b.varName;
          return false;
        }
        if (nit->second.state == NodeState::Error) {
          // Never compute on a dead upstream: its stored result is cleared, and reporting
          // the cause is more useful than the generic "unbound input".
          *errorCode = "upstreamError";
          *errorName = "upstream node " + std::to_string(b.sourceNodeId) + " failed (" +
                       nit->second.errorCode + ")";
          return false;
        }
        // v2: pick the declared output of a K-output upstream.
        const auto& outs = nit->second.resultMatrixIds;
        if (b.sourceOutputIndex < 0 ||
            static_cast<size_t>(b.sourceOutputIndex) >= outs.size()) {
          *errorCode = "unknownColumn";
          *errorName = b.varName + " (missing output " + std::to_string(b.sourceOutputIndex) + ")";
          return false;
        }
        matrixId = outs[static_cast<size_t>(b.sourceOutputIndex)];
      } else if (b.sourceMatrixId >= 0) {
        // A node result can be bound as a plain matrix; when its producer failed, this
        // port must inherit the error instead of reading the (now cleared) result.
        auto ownerIt = resultOwner_.find(matrixKey(b.sourceMatrixId));
        if (ownerIt != resultOwner_.end()) {
          auto nit = nodes_.find(ownerIt->second.first);
          if (nit != nodes_.end() && nit->second.state == NodeState::Error) {
            *errorCode = "upstreamError";
            *errorName = "upstream node " + std::to_string(ownerIt->second.first) +
                         " failed (" + nit->second.errorCode + ")";
            return false;
          }
        }
        matrixId = b.sourceMatrixId;
      } else {
        *errorCode = "unknownColumn";
        *errorName = b.varName;
        return false;
      }
    }

    size_t columnCount = 0;
    const std::string alias = b.varName;
    const bool found = store_->withMatrix(matrixId, [&](const Matrix& m) {
      for (const auto& col : m.columns()) {
        names->push_back(Matrix::label(col));
        data->push_back(col.data);
      }
      // The alias must keep names.size() == data.size(): the engine indexes data by the
      // resolved name index (a mismatched pair reads out of bounds — found by smoke test).
      if (m.columnCount() == 1 && !alias.empty()) {
        names->push_back(alias);
        data->push_back(m.column(0).data);
      }
      columnCount = m.columnCount();
      *length = std::max(*length, m.rowCount());
    });
    if (!found || columnCount == 0) {
      *errorCode = "unknownColumn";
      *errorName = b.varName;
      return false;
    }
  }
  return true;
}

void NodeRegistry::failNodeLocked(int64_t nodeId, const std::string& code, Json params) {
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return;
  ComputeNode& node = it->second;
  node.state = NodeState::Error;
  node.errorCode = code;
  node.errorParams = std::move(params);
  // Drop the previous results: an erroring node must not keep serving the numbers from
  // its last successful run (audit finding: downstream cards read stale values and
  // still displayed state "done").
  for (int64_t resultId : node.resultMatrixIds) store_->replace(resultId, {});
  bus_->publish(Json::object({{"nodeId", Json(static_cast<int64_t>(node.id))},
                              {"state", Json(std::string("error"))},
                              {"code", Json(node.errorCode)},
                              {"params", node.errorParams}}));
}

void NodeRegistry::evaluateNode(int64_t nodeId) {
  // ── phase 1 (locked, short): publish `computing` and copy the evaluation request ──
  std::vector<PortBinding> bindings;
  std::string formula;
  std::string signatureId;
  Json params = Json::object();
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = nodes_.find(nodeId);
    if (it == nodes_.end()) return;
    it->second.state = NodeState::Computing;
    bus_->publish(Json::object({{"nodeId", Json(nodeId)},
                                {"state", Json(std::string("computing"))}}));
    bindings = it->second.inputs;
    formula = it->second.formula;
    signatureId = it->second.signatureId;
    params = it->second.params;
  }

  // ── phase 2 (unlocked): resolve inputs; the store has its own mutex ──
  std::vector<std::string> names;
  std::vector<std::vector<double>> data;
  size_t length = 0;
  std::string gatherCode;
  std::string gatherName;
  if (!gatherInputs(bindings, &names, &data, &length, &gatherCode, &gatherName)) {
    std::lock_guard<std::mutex> lock(mu_);
    failNodeLocked(nodeId, gatherCode, Json::object({{"name", Json(gatherName)}}));
    return;
  }

  // ── phase 3 (unlocked): evaluate. NOTHING here holds mu_. ──
  // One `vector<Column>` per declared output ordinal. K is fixed by the signature; the
  // evaluator only decides what goes *inside* each output, never how many there are.
  std::vector<std::vector<Column>> outputs;
  std::string errorCode;
  std::string errorName;
  int64_t errorPosition = -1;
  const size_t rowLength = length == 0 ? 1 : length;
  try {
    if (!signatureId.empty()) {
      if (signatureId == kSigExpressionColumns) {
        // builtin:expression-columns — one wide table, one column per expression. This is
        // the v1 formula card's semantics, now computed once in one node instead of once
        // per column in N nodes (the browser-side merge disappears with it).
        std::vector<Column> columns;
        const Json* formulas = params.find("formulas");
        if (!formulas || !formulas->isArray() || formulas->items().empty()) {
          errorCode = "badSignatureParams";
          errorName = "formulas";
        } else {
          const auto& list = formulas->items();
          for (size_t i = 0; i < list.size(); ++i) {
            const Json& f = list[i];
            const std::string expression = f["expression"].isString() ? f["expression"].asString() : "";
            std::string name = f["name"].isString() ? f["name"].asString() : "";
            if (name.empty()) name = "Col" + std::to_string(i + 1);
            Column col;
            col.posName = "Pos." + std::to_string(i + 1);
            col.annotation = name;
            col.data = ExprEngine::evaluate(expression, names, data, rowLength);
            columns.push_back(std::move(col));
          }
        }
        if (errorCode.empty()) outputs.push_back(std::move(columns));
      } else {
        errorCode = "unknownSignature";
        errorName = signatureId;
      }
    } else {
      std::vector<double> values = ExprEngine::evaluate(formula, names, data, rowLength);
      Column out;
      out.posName = "Pos.1";
      out.annotation = "";
      out.data = std::move(values);
      outputs.push_back({std::move(out)});
    }
  } catch (const ExpressionError& e) {
    errorCode = e.code;
    errorPosition = e.position;
  } catch (const ShapeError& e) {
    // Matrix-mode shape failures are structured too (never a silent garbage matrix).
    errorCode = e.code;
    errorName = e.what();
  } catch (const std::exception&) {
    errorCode = "internalError";
  }

  // ── phase 3b (unlocked): column contract ──
  // The output list of a function card may carry a promised column count
  // (`params.columnContract`), set when the user first names the output's columns. It is
  // an explicit contract, not a shape heuristic: when the produced width drifts, the data
  // flow STOPS HERE with a structured error instead of silently re-labelling columns.
  // K (the number of outputs) is still fixed by the signature; this is about the width of
  // one output table.
  int64_t contractExpected = -1;
  int64_t contractActual = -1;
  if (errorCode.empty()) {
    const Json* contract = params.find("columnContract");
    if (contract && contract->isObject() && (*contract)["columns"].isNumber()) {
      contractExpected = static_cast<int64_t>((*contract)["columns"].asNumber());
      contractActual = outputs.empty() ? 0 : static_cast<int64_t>(outputs[0].size());
      if (contractExpected != contractActual) {
        errorCode = "columnContractViolation";
        errorName.clear();
      }
    }
  }

  // ── phase 4 (locked, short): commit ──
  std::lock_guard<std::mutex> lock(mu_);
  auto it = nodes_.find(nodeId);
  if (it == nodes_.end()) return;  // deleted while computing
  ComputeNode& node = it->second;
  if (!errorCode.empty()) {
    Json params_out = Json::object();
    if (errorPosition >= 0) params_out.set("position", Json(errorPosition));
    if (!errorName.empty()) params_out.set("name", Json(errorName));
    if (contractExpected >= 0) {
      params_out.set("expected", Json(contractExpected));
      params_out.set("actual", Json(contractActual));
    }
    failNodeLocked(nodeId, errorCode, std::move(params_out));
    return;
  }
  // The signature promised K outputs; a short fill is a structured error, never UB
  // (port-semantics-v1 §evaluation: "少填 = 结构化错误").
  if (outputs.size() != node.resultMatrixIds.size()) {
    failNodeLocked(nodeId, "internalError",
                   Json::object({{"expected", Json(static_cast<int64_t>(node.resultMatrixIds.size()))},
                                 {"got", Json(static_cast<int64_t>(outputs.size()))}}));
    return;
  }
  for (size_t i = 0; i < outputs.size(); ++i)
    store_->replace(node.resultMatrixIds[i], std::move(outputs[i]));
  node.state = NodeState::Done;
  node.errorCode.clear();
  Json done = Json::object({{"nodeId", Json(nodeId)},
                            {"state", Json(std::string("done"))},
                            {"matrixId", Json(node.resultMatrixIds[0])}});
  if (node.resultMatrixIds.size() > 1) {
    Json ids = Json::array();
    for (int64_t id : node.resultMatrixIds) ids.push(Json(id));
    done.set("resultMatrixIds", std::move(ids));
  }
  bus_->publish(std::move(done));
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
      // The node's result matrices are mid-edges: whoever binds any of them depends on
      // this node. K outputs ⇒ K keys.
      auto nit = nodes_.find(cur);
      if (nit != nodes_.end()) {
        for (int64_t resultId : nit->second.resultMatrixIds) {
          auto rit = dependents_.find(matrixKey(resultId));
          if (rit != dependents_.end())
            for (int64_t d : rit->second) q.push(d);
        }
      }
    }
  }
  // Topo order via BFS above is already dependency-first because edges point
  // source->dependent; evaluate each node in turn. evaluateNode() takes the lock in short
  // bursts itself, so this loop holds no lock at all — a slow node cannot freeze the
  // registry (docs/decisions/2026-10-15-max-headroom-principle.md).
  for (int64_t id : order) evaluateNode(id);
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
