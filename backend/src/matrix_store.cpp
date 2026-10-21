#include "matrix_store.h"

#include <algorithm>

namespace dc {

int64_t MatrixStore::insert(Matrix m) {
  std::lock_guard<std::mutex> lock(mu_);
  m.id = nextId_++;
  int64_t id = m.id;
  matrices_.emplace(id, std::move(m));
  return id;
}

bool MatrixStore::replace(int64_t id, std::vector<Column> columns) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = matrices_.find(id);
  if (it == matrices_.end()) return false;
  it->second.setColumns(std::move(columns));
  ++it->second.revision;
  return true;
}

bool MatrixStore::patchCells(int64_t id, const std::vector<CellPatch>& patches, int64_t* revision) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = matrices_.find(id);
  if (it == matrices_.end()) return false;
  // Validate the whole batch first so a bad coordinate never leaves a half-applied edit.
  for (const CellPatch& p : patches) {
    if (p.col >= it->second.columnCount()) return false;
    if (p.row >= it->second.column(p.col).data.size()) return false;
  }
  for (const CellPatch& p : patches) it->second.setCell(p.row, p.col, p.value);
  ++it->second.revision;
  if (revision) *revision = it->second.revision;
  return true;
}

bool MatrixStore::remove(int64_t id) {
  std::lock_guard<std::mutex> lock(mu_);
  return matrices_.erase(id) > 0;
}

bool MatrixStore::snapshot(int64_t id, Matrix* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = matrices_.find(id);
  if (it == matrices_.end()) return false;
  *out = it->second;
  return true;
}

bool MatrixStore::labels(int64_t id, std::vector<std::string>* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = matrices_.find(id);
  if (it == matrices_.end()) return false;
  out->clear();
  out->reserve(it->second.columnCount());
  for (const Column& col : it->second.columns()) out->push_back(Matrix::label(col));
  return true;
}

size_t MatrixStore::window(int64_t id, size_t start, size_t count,
                           std::vector<std::vector<double>>* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  out->clear();
  auto it = matrices_.find(id);
  if (it == matrices_.end()) return 0;
  const Matrix& m = it->second;
  const size_t rows = m.rowCount();
  const size_t begin = std::min(start, rows);
  const size_t end = std::min(rows, begin + count);
  for (const Column& col : m.columns()) {
    out->push_back(std::vector<double>(col.data.begin() + static_cast<long>(begin),
                                       col.data.begin() + static_cast<long>(end)));
  }
  return end - begin;
}

size_t MatrixStore::size() const {
  std::lock_guard<std::mutex> lock(mu_);
  return matrices_.size();
}

}  // namespace dc
