#include "matrix_value.h"

#include <cmath>

namespace dc {

void MatVal::broadcastShapes(const MatVal& a, const MatVal& b,
                             int64_t* outRows, int64_t* outCols) {
  if (a.isScalar()) { *outRows = b.rows_; *outCols = b.cols_; return; }
  if (b.isScalar()) { *outRows = a.rows_; *outCols = a.cols_; return; }
  if (a.rows_ == b.rows_ && a.cols_ == b.cols_) {
    *outRows = a.rows_; *outCols = a.cols_; return;
  }
  throw ShapeError("shape mismatch: (" + std::to_string(a.rows_) + "×" +
                   std::to_string(a.cols_) + ") vs (" + std::to_string(b.rows_) + "×" +
                   std::to_string(b.cols_) + ")");
}

// ── element-wise ───────────────────────────────────────────────────────

MatVal MatVal::add(const MatVal& a, const MatVal& b) {
  if (a.isScalar() && !b.isScalar()) return MatVal(b.data_.array() + a.scalar());
  if (b.isScalar() && !a.isScalar()) return MatVal(a.data_.array() + b.scalar());
  int64_t r, c; broadcastShapes(a, b, &r, &c);
  return MatVal(a.data_ + b.data_);
}

MatVal MatVal::sub(const MatVal& a, const MatVal& b) {
  if (a.isScalar() && !b.isScalar()) return MatVal(Eigen::MatrixXd::Constant(b.rows_, b.cols_, a.scalar()) - b.data_);
  if (b.isScalar() && !a.isScalar()) return MatVal(a.data_.array() - b.scalar());
  int64_t r, c; broadcastShapes(a, b, &r, &c);
  return MatVal(a.data_ - b.data_);
}

MatVal MatVal::mulElementwise(const MatVal& a, const MatVal& b) {
  if (a.isScalar()) return MatVal(b.data_.array() * a.scalar());
  if (b.isScalar()) return MatVal(a.data_.array() * b.scalar());
  int64_t r, c; broadcastShapes(a, b, &r, &c);
  return MatVal(a.data_.cwiseProduct(b.data_));
}

MatVal MatVal::divElementwise(const MatVal& a, const MatVal& b) {
  if (b.isScalar()) return MatVal(a.data_.array() / b.scalar());
  if (a.isScalar()) return MatVal(Eigen::MatrixXd::Constant(b.rows_, b.cols_, a.scalar()).array() / b.data_.array());
  int64_t r, c; broadcastShapes(a, b, &r, &c);
  return MatVal(a.data_.cwiseQuotient(b.data_));
}

MatVal MatVal::modElementwise(const MatVal& a, const MatVal& b) {
  // fmod element-wise with broadcast.
  auto fmodOp = [](double x, double y) { return std::fmod(x, y); };
  if (a.isScalar()) {
    Eigen::MatrixXd r = b.data_.unaryExpr([sv = a.scalar(), &fmodOp](double y) { return fmodOp(sv, y); });
    return MatVal(r);
  }
  if (b.isScalar()) {
    Eigen::MatrixXd r = a.data_.unaryExpr([sv = b.scalar(), &fmodOp](double x) { return fmodOp(x, sv); });
    return MatVal(r);
  }
  int64_t rows, cols; broadcastShapes(a, b, &rows, &cols);
  Eigen::MatrixXd r(rows, cols);
  for (int64_t i = 0; i < rows; ++i)
    for (int64_t j = 0; j < cols; ++j)
      r(i, j) = fmodOp(a.data_(i, j), b.data_(i, j));
  return MatVal(r);
}

MatVal MatVal::powElementwise(const MatVal& a, const MatVal& b) {
  if (a.isScalar() && b.isScalar()) return MatVal(Eigen::MatrixXd::Constant(1, 1, std::pow(a.scalar(), b.scalar())));
  if (b.isScalar()) {
    Eigen::MatrixXd r = a.data_.unaryExpr([e = b.scalar()](double x) { return std::pow(x, e); });
    return MatVal(r);
  }
  if (a.isScalar()) {
    Eigen::MatrixXd r = b.data_.unaryExpr([base = a.scalar()](double e) { return std::pow(base, e); });
    return MatVal(r);
  }
  int64_t rows, cols; broadcastShapes(a, b, &rows, &cols);
  Eigen::MatrixXd r(rows, cols);
  for (int64_t i = 0; i < rows; ++i)
    for (int64_t j = 0; j < cols; ++j)
      r(i, j) = std::pow(a.data_(i, j), b.data_(i, j));
  return MatVal(r);
}

MatVal MatVal::negate(const MatVal& a) {
  return MatVal(-a.data_);
}

// ── matrix ops ─────────────────────────────────────────────────────────

MatVal MatVal::matmul(const MatVal& a, const MatVal& b) {
  if (a.cols_ != b.rows_) {
    throw ShapeError("matmul shape mismatch: (" + std::to_string(a.rows_) + "×" +
                     std::to_string(a.cols_) + ") × (" + std::to_string(b.rows_) + "×" +
                     std::to_string(b.cols_) + ")");
  }
  return MatVal(a.data_ * b.data_);
}

MatVal MatVal::transpose(const MatVal& a) {
  return MatVal(a.data_.transpose());
}

double MatVal::determinant(const MatVal& a) {
  if (a.rows_ != a.cols_) {
    throw ShapeError("determinant requires square matrix, got " +
                     std::to_string(a.rows_) + "×" + std::to_string(a.cols_));
  }
  return a.data_.determinant();
}

MatVal MatVal::inverse(const MatVal& a) {
  if (a.rows_ != a.cols_) {
    throw ShapeError("inverse requires square matrix, got " +
                     std::to_string(a.rows_) + "×" + std::to_string(a.cols_));
  }
  Eigen::FullPivLU<Eigen::MatrixXd> lu(a.data_);
  if (!lu.isInvertible()) {
    throw ShapeError("singular matrix cannot be inverted");
  }
  return MatVal(lu.inverse());
}

MatVal MatVal::solve(const MatVal& A, const MatVal& b) {
  if (A.rows_ != A.cols_) {
    throw ShapeError("solve requires square A, got " +
                     std::to_string(A.rows_) + "×" + std::to_string(A.cols_));
  }
  if (A.rows_ != b.rows_) {
    throw ShapeError("solve dimension mismatch: A is " + std::to_string(A.rows_) +
                     "×" + std::to_string(A.cols_) + " but b has " +
                     std::to_string(b.rows_) + " rows");
  }
  Eigen::FullPivLU<Eigen::MatrixXd> lu(A.data_);
  if (!lu.isInvertible()) {
    throw ShapeError("singular matrix in solve");
  }
  return MatVal(lu.solve(b.data_));
}

// ── conversions ────────────────────────────────────────────────────────

MatVal MatVal::fromColumn(const std::vector<double>& v) {
  int64_t n = static_cast<int64_t>(v.size());
  Eigen::MatrixXd m(n, 1);
  for (int64_t i = 0; i < n; ++i) m(i, 0) = v[i];
  return MatVal(m);
}

MatVal MatVal::fromFlat(const double* data, int64_t rows, int64_t cols) {
  Eigen::MatrixXd m(rows, cols);
  // Input is column-major (matches our wire format).
  for (int64_t j = 0; j < cols; ++j)
    for (int64_t i = 0; i < rows; ++i)
      m(i, j) = data[j * rows + i];
  return MatVal(m);
}

std::vector<double> MatVal::toColumnMajor() const {
  std::vector<double> out(static_cast<size_t>(rows_ * cols_));
  for (int64_t j = 0; j < cols_; ++j)
    for (int64_t i = 0; i < rows_; ++i)
      out[static_cast<size_t>(j * rows_ + i)] = data_(i, j);
  return out;
}

}  // namespace dc
