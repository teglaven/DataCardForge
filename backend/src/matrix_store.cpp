#include "matrix_store.h"

#include <algorithm>

namespace dc {

int64_t MatrixStore::insert(Matrix m) {
  m.id = nextId_++;
  int64_t id = m.id;
  matrices_.emplace(id, std::move(m));
  return id;
}

bool MatrixStore::replace(int64_t id, std::vector<Column> columns) {
  auto it = matrices_.find(id);
  if (it == matrices_.end()) return false;
  it->second.setColumns(std::move(columns));
  ++it->second.revision;
  return true;
}

const Matrix* MatrixStore::get(int64_t id) const {
  auto it = matrices_.find(id);
  return it == matrices_.end() ? nullptr : &it->second;
}

bool MatrixStore::remove(int64_t id) { return matrices_.erase(id) > 0; }

size_t MatrixStore::window(int64_t id, size_t start, size_t count,
                           std::vector<std::vector<double>>* out) const {
  const Matrix* m = get(id);
  out->clear();
  if (!m) return 0;
  const size_t rows = m->rowCount();
  const size_t begin = std::min(start, rows);
  const size_t end = std::min(rows, begin + count);
  for (const auto& col : m->columns()) {
    out->push_back(std::vector<double>(col.data.begin() + static_cast<long>(begin),
                                       col.data.begin() + static_cast<long>(end)));
  }
  return end - begin;
}

}  // namespace dc
