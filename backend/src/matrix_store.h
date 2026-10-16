// Server-authoritative column-oriented matrix store with revision counters.
// The browser keeps only a revision-keyed read-only display cache
// (docs/decisions/2026-10-17-backend-owns-compute.md).
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace dc {

struct Column {
  std::string posName;    // "Pos.1" …
  std::string annotation; // header row when the file had one
  std::vector<double> data;
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

  // Display label used across the protocol: annotation when present, else Pos.N.
  static std::string label(const Column& c) {
    return c.annotation.empty() ? c.posName : c.posName + " " + c.annotation;
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

  const Matrix* get(int64_t id) const;
  bool remove(int64_t id);

  // Rows [start, start+count) of every column, column-major into `out`
  // (out[col] has min(count, rows) doubles). Returns rows copied per column.
  size_t window(int64_t id, size_t start, size_t count, std::vector<std::vector<double>>* out) const;

  size_t size() const { return matrices_.size(); }

 private:
  std::map<int64_t, Matrix> matrices_;
  int64_t nextId_ = 1;
};

}  // namespace dc
