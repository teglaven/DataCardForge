// Matrix value type for the B-plan matrix mode (docs/decisions/2026-10-17-backend-owns-compute.md).
// Wraps an Eigen matrix with shape metadata so the expression engine can enforce
// dimension compatibility and report structured shapeMismatch errors instead of
// producing silent garbage.
#pragma once

#include <Eigen/Dense>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace dc {

struct ShapeError : std::runtime_error {
  std::string code = "shapeMismatch";
  ShapeError(std::string message) : std::runtime_error(std::move(message)) {}
};

/**
 * A matrix value in the expression engine. Scalar = 1×1, vector = N×1 or 1×N,
 * matrix = M×N. All arithmetic goes through this type when any operand is matrix-mode.
 */
class MatVal {
 public:
  MatVal() : rows_(0), cols_(0) {}
  MatVal(int64_t rows, int64_t cols) : rows_(rows), cols_(cols), data_(rows, cols) {}
  explicit MatVal(const Eigen::MatrixXd& m) : rows_(m.rows()), cols_(m.cols()), data_(m) {}

  int64_t rows() const { return rows_; }
  int64_t cols() const { return cols_; }
  bool isScalar() const { return rows_ == 1 && cols_ == 1; }
  bool isVector() const { return (rows_ == 1 || cols_ == 1) && !isScalar(); }
  bool isEmpty() const { return rows_ == 0 || cols_ == 0; }

  const Eigen::MatrixXd& eigen() const { return data_; }
  Eigen::MatrixXd& eigen() { return data_; }

  double scalar() const { return data_(0, 0); }

  // ── element-wise ops (always valid when shapes match or one is scalar) ──

  static MatVal add(const MatVal& a, const MatVal& b);
  static MatVal sub(const MatVal& a, const MatVal& b);
  static MatVal mulElementwise(const MatVal& a, const MatVal& b);
  static MatVal divElementwise(const MatVal& a, const MatVal& b);
  static MatVal modElementwise(const MatVal& a, const MatVal& b);
  static MatVal powElementwise(const MatVal& a, const MatVal& b);
  static MatVal negate(const MatVal& a);

  // ── matrix ops (require compatible dimensions) ──

  /** Matrix multiplication: (M×K) * (K×N) → (M×N). Throws ShapeError on mismatch. */
  static MatVal matmul(const MatVal& a, const MatVal& b);

  /** Transpose: (M×N) → (N×M). Always valid. */
  static MatVal transpose(const MatVal& a);

  /** Determinant: requires square matrix. Throws ShapeError otherwise. */
  static double determinant(const MatVal& a);

  /** Inverse: requires square, non-singular. Throws ShapeError on singular/non-square. */
  static MatVal inverse(const MatVal& a);

  /** Solve Ax=b: A must be square, b must have matching rows. Returns x. */
  static MatVal solve(const MatVal& A, const MatVal& b);

  // ── conversions ──

  /** Build from a column vector (std::vector<double>). Result is N×1. */
  static MatVal fromColumn(const std::vector<double>& v);

  /** Build from a flat row-major array with given shape. */
  static MatVal fromFlat(const double* data, int64_t rows, int64_t cols);

  /** Extract as column-major std::vector<double> (for result storage). */
  std::vector<double> toColumnMajor() const;

  /** Broadcast scalar to match target shape. Throws if neither is scalar and shapes differ. */
  static void broadcastShapes(const MatVal& a, const MatVal& b,
                              int64_t* outRows, int64_t* outCols);

 private:
  int64_t rows_;
  int64_t cols_;
  Eigen::MatrixXd data_;
};

}  // namespace dc
