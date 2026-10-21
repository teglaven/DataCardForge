// Server-authoritative column-oriented matrix store with revision counters.
// The browser keeps only a revision-keyed read-only display cache
// (docs/decisions/2026-10-17-backend-owns-compute.md).
//
// Concurrency: the HTTP server runs one thread per connection, so every public
// method locks `mu_`. No method hands out a pointer into `matrices_` — callers
// either copy (`snapshot`/`labels`/`window`) or run a callback under the lock
// (`withMatrix`). Handing out raw pointers was a use-after-free window the first
// audit found (a concurrent DELETE could erase the element mid-read).
#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace dc {

struct Column {
  std::string posName;    // "Pos.1" …
  std::string annotation; // header row when the file had one
  std::vector<double> data;
};

// One cell overwrite from the browser (protocol v1 extension: PATCH /api/matrices/{id}).
struct CellPatch {
  size_t row = 0;
  size_t col = 0;
  double value = 0;
};

class Matrix {
 public:
  Matrix() = default;
  explicit Matrix(std::vector<Column> columns) : columns_(std::move(columns)) {}

  int64_t id = 0;
  int64_t revision = 1;
  std::string name;

  size_t columnCount() const { return columns_.size(); }
  size_t rowCount() const { return columns_.empty() ? 0 : columns_.front().data.size(); }
  const std::vector<Column>& columns() const { return columns_; }
  const Column& column(size_t i) const { return columns_[i]; }
  void setColumns(std::vector<Column> columns) { columns_ = std::move(columns); }

  // Bounds-checked single-cell write; false when the coordinate is outside the shape.
  bool setCell(size_t row, size_t col, double value) {
    if (col >= columns_.size()) return false;
    std::vector<double>& data = columns_[col].data;
    if (row >= data.size()) return false;
    data[row] = value;
    return true;
  }

  // Display label used across the protocol: annotation when present, else Pos.N.
  static std::string label(const Column& c) {
    return c.annotation.empty() ? c.posName : c.posName + " " + c.annotation;
  }

  // Inverse of label(): "Pos.1 temp" → posName="Pos.1", annotation="temp".
  static void labelParsed(const std::string& label, std::string* posName, std::string* annotation) {
    const size_t space = label.find(' ');
    if (space != std::string::npos && label.compare(0, 4, "Pos.") == 0) {
      *posName = label.substr(0, space);
      *annotation = label.substr(space + 1);
    } else {
      *posName = label;
      annotation->clear();
    }
  }

 private:
  std::vector<Column> columns_;
};

class MatrixStore {
 public:
  // Insert content and return the assigned id. Revision starts at 1.
  int64_t insert(Matrix m);

  // Replace all columns of an existing matrix; bumps its revision. False if absent.
  bool replace(int64_t id, std::vector<Column> columns);

  // Apply cell overwrites. False when the matrix is absent; out-of-range patches
  // are refused without touching the stored data (all-or-nothing).
  bool patchCells(int64_t id, const std::vector<CellPatch>& patches, int64_t* revision);

  bool remove(int64_t id);

  // Locked read helpers — all copy, none leak a pointer into the map.
  bool snapshot(int64_t id, Matrix* out) const;
  bool labels(int64_t id, std::vector<std::string>* out) const;

  // Run `fn` on the matrix while holding the lock (no copy, no dangling pointer).
  template <typename Fn>
  bool withMatrix(int64_t id, Fn&& fn) const {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = matrices_.find(id);
    if (it == matrices_.end()) return false;
    fn(it->second);
    return true;
  }

  // Rows [start, start+count) of every column, column-major into `out`
  // (out[col] has min(count, rows) doubles). Returns rows copied per column.
  size_t window(int64_t id, size_t start, size_t count, std::vector<std::vector<double>>* out) const;

  size_t size() const;

 private:
  mutable std::mutex mu_;
  std::map<int64_t, Matrix> matrices_;
  int64_t nextId_ = 1;
};

}  // namespace dc
