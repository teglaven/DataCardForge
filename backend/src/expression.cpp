#include "expression.h"
#include "matrix_value.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <memory>
#include <numeric>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace dc {

namespace {

// ── tokenizer (mirrors tokenize() in expression.ts) ────────────────────

enum class Tok { Number, Ident, Op, LParen, RParen, Comma, Compare, Eof };

struct Token {
  Tok type;
  std::string value;
  int64_t pos;
};

std::string toLower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

std::string toUpper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
  return s;
}

bool isDigit(char c) { return c >= '0' && c <= '9'; }
bool isIdentStart(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}
bool isIdentChar(char c) { return isIdentStart(c) || isDigit(c) || c == '.'; }

// JS `Math.round`, which the TS reference uses for ROUND: half rounds toward +Infinity,
// whereas std::round rounds half away from zero (Math.round(-1.5) = -1 but
// std::round(-1.5) = -2), and a result landing in [-0.5, 0) is -0 rather than +0.
// Both differences are observable across tiers and were found by the differential fuzz.
inline double jsRound(double x) {
  if (!std::isfinite(x) || x == 0.0) return x;
  const double r = std::floor(x + 0.5);
  return (r == 0.0 && x < 0.0) ? -0.0 : r;
}

// JS `Math.min` / `Math.max`, which the TS reference uses for MIN/MAX and for the MOV
// window bounds: any NaN operand wins (std::min/max instead return the other operand
// whenever the NaN comes second), and ±0 is ordered so min(-0,+0) = -0, max(-0,+0) = +0.
inline double jsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return (std::signbit(a) || std::signbit(b)) ? -0.0 : 0.0;
  return std::min(a, b);
}

inline double jsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  if (a == 0.0 && b == 0.0) return (std::signbit(a) && std::signbit(b)) ? -0.0 : 0.0;
  return std::max(a, b);
}

// JS `Math.pow` (and `**`), which the TS reference uses for POW and for the `^` operator,
// differs from std::pow on two points the language specs settle differently:
//   * a NaN exponent yields NaN even for base 1 — C99 explicitly returns 1 for
//     pow(+1, y) "for any y, even a NaN" (found by the differential fuzz:
//     POW(POW(B != A, LN(A)), B) collapsed to 1 on the C++ side while TS produced NaN);
//   * base ±1 with an infinite exponent yields NaN — C99 returns 1.
// Order follows the ECMAScript algorithm, so NaN exponent wins over a NaN base.
inline double jsPow(double base, double exp) {
  if (std::isnan(exp)) return NAN;
  if (exp == 0.0) return 1.0;  // covers ±0, and applies even when the base is NaN
  if (std::isnan(base)) return NAN;
  if ((base == 1.0 || base == -1.0) && std::isinf(exp)) return NAN;
  return std::pow(base, exp);
}

std::vector<Token> tokenize(const std::string& input) {
  static const std::string kOps = "+-*/^%";
  static const std::vector<std::string> kCompares = {">=", "<=", "==", "!=", ">", "<"};
  std::vector<Token> tokens;
  size_t i = 0;
  while (i < input.size()) {
    char ch = input[i];
    if (std::isspace(static_cast<unsigned char>(ch))) { ++i; continue; }
    if (isDigit(ch) || (ch == '.' && i + 1 < input.size() && isDigit(input[i + 1]))) {
      size_t start = i;
      while (i < input.size() && (isDigit(input[i]) || input[i] == '.')) ++i;
      if (i < input.size() && (input[i] == 'e' || input[i] == 'E')) {
        ++i;
        if (i < input.size() && (input[i] == '+' || input[i] == '-')) ++i;
        while (i < input.size() && isDigit(input[i])) ++i;
      }
      tokens.push_back({Tok::Number, input.substr(start, i - start), static_cast<int64_t>(start)});
      continue;
    }
    if (isIdentStart(ch)) {
      size_t start = i;
      while (i < input.size() && isIdentChar(input[i])) ++i;
      tokens.push_back({Tok::Ident, input.substr(start, i - start), static_cast<int64_t>(start)});
      continue;
    }
    bool matched = false;
    for (const auto& two : kCompares) {
      if (input.compare(i, 2, two) == 0) {
        tokens.push_back({Tok::Compare, two, static_cast<int64_t>(i)});
        i += 2;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (ch == '>' || ch == '<') {
      tokens.push_back({Tok::Compare, std::string(1, ch), static_cast<int64_t>(i)});
      ++i;
      continue;
    }
    if (kOps.find(ch) != std::string::npos) {
      tokens.push_back({Tok::Op, std::string(1, ch), static_cast<int64_t>(i)});
      ++i;
      continue;
    }
    if (ch == '(') { tokens.push_back({Tok::LParen, "(", static_cast<int64_t>(i)}); ++i; continue; }
    if (ch == ')') { tokens.push_back({Tok::RParen, ")", static_cast<int64_t>(i)}); ++i; continue; }
    if (ch == ',') { tokens.push_back({Tok::Comma, ",", static_cast<int64_t>(i)}); ++i; continue; }
    throw ExpressionError("Unexpected character '" + std::string(1, ch) + "' at position " +
                              std::to_string(i),
                          static_cast<int64_t>(i), "unexpectedChar");
  }
  tokens.push_back({Tok::Eof, "", static_cast<int64_t>(input.size())});
  return tokens;
}

// ── AST ────────────────────────────────────────────────────────────────

struct Node;
using NodePtr = std::shared_ptr<Node>;

enum class NodeKind { Number, Column, Binary, Unary, Call };

struct Node {
  NodeKind kind;
  double number = 0;          // Number
  int column = -1;            // Column: index into the provided columns
  std::string columnName;     // Column: original spelling (for references())
  std::string op;             // Binary / Unary
  std::string name;           // Call: upper-cased function name
  std::vector<NodePtr> children;
};

// ── parser (recursive-descent with precedence climbing, mirrors parse()) ─

struct FunctionSpec {
  int minArgs;
  int maxArgs;  // INT32_MAX for variadic
};

const std::unordered_map<std::string, FunctionSpec>& functions() {
  static const std::unordered_map<std::string, FunctionSpec> kFns = {
      {"SUM", {1, 1}},   {"AVG", {1, 1}},    {"MEAN", {1, 1}}, {"MIN", {1, INT32_MAX}},
      {"MAX", {1, INT32_MAX}}, {"MEDIAN", {1, 1}}, {"STD", {1, 1}}, {"ABS", {1, 1}},
      {"SQRT", {1, 1}},  {"LOG", {1, 1}},    {"LN", {1, 1}},   {"LOG10", {1, 1}},
      {"EXP", {1, 1}},   {"POW", {2, 2}},    {"ROUND", {1, 2}}, {"FLOOR", {1, 1}},
      {"CEIL", {1, 1}},  {"SIGN", {1, 1}},   {"MOV", {2, 2}},  {"EMA", {2, 2}},
      {"IF", {3, 3}},
      // Matrix-mode functions (only meaningful when evaluateMatrix is used; cell-mode
      // evaluate() will reject them as unknown — that's fine, they're matrix-only).
      {"TRANSPOSE", {1, 1}},
      {"DET", {1, 1}},
      {"INV", {1, 1}},
      {"SOLVE", {2, 2}},
      {"MMUL", {2, 2}},
      {"EMUL", {2, 2}},
  };
  return kFns;
}

const std::unordered_set<std::string>& aggregationNames() {
  static const std::unordered_set<std::string> kAgg = {
      "SUM", "AVG", "MEAN", "MIN", "MAX", "MEDIAN", "STD"};
  return kAgg;
}

int precedence(const std::string& op) {
  static const std::unordered_map<std::string, int> kPrec = {
      {"||", 1}, {"&&", 2}, {"==", 3}, {"!=", 3}, {">", 3}, {"<", 3}, {">=", 3}, {"<=", 3},
      {"+", 4}, {"-", 4}, {"*", 5}, {"/", 5}, {"%", 5}, {"^", 6}};
  auto it = kPrec.find(op);
  return it == kPrec.end() ? 0 : it->second;
}

struct Parser {
  const std::vector<Token>& tokens;
  const std::unordered_map<std::string, int>& columns;
  size_t pos = 0;

  const Token& peek() const { return tokens[pos]; }
  const Token& advance() { return tokens[pos++]; }

  NodePtr parseExpression(int minPrec = 0) {
    NodePtr left = parseUnary();
    while (true) {
      const Token& t = peek();
      std::string op;
      if (t.type == Tok::Op || t.type == Tok::Compare) op = t.value;
      int prec = op.empty() ? 0 : precedence(op);
      if (op.empty() || !kBinaryOps.count(op) || prec < minPrec) break;
      advance();
      int nextMin = (op == "^") ? prec : prec + 1;
      NodePtr right = parseExpression(nextMin);
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Binary;
      n->op = op;
      n->children = {left, right};
      left = n;
    }
    return left;
  }

  NodePtr parseUnary() {
    const Token& t = peek();
    if (t.type == Tok::Op && (t.value == "-" || t.value == "+")) {
      advance();
      NodePtr operand = parseUnary();
      if (t.value == "+") return operand;
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Unary;
      n->op = "-";
      n->children = {operand};
      return n;
    }
    return parsePrimary();
  }

  NodePtr parsePrimary() {
    const Token& t = peek();
    if (t.type == Tok::Number) {
      advance();
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Number;
      n->number = std::stod(t.value);
      return n;
    }
    if (t.type == Tok::Ident) {
      advance();
      const std::string name = t.value;
      if (peek().type == Tok::LParen) {
        std::string upper = toUpper(name);
        const auto& fns = functions();
        auto fit = fns.find(upper);
        if (fit == fns.end()) {
          throw ExpressionError("Unknown function '" + name + "'", t.pos, "unknownFunction");
        }
        advance();  // consume '('
        std::vector<NodePtr> args;
        if (peek().type != Tok::RParen) {
          args.push_back(parseExpression());
          while (peek().type == Tok::Comma) {
            advance();
            args.push_back(parseExpression());
          }
        }
        if (peek().type != Tok::RParen) {
          throw ExpressionError("Expected ')' after function arguments", peek().pos,
                                "expectedCloseAfterArgs");
        }
        advance();  // consume ')'
        int got = static_cast<int>(args.size());
        if (got < fit->second.minArgs || got > fit->second.maxArgs) {
          std::string maxStr = fit->second.maxArgs == INT32_MAX
                                   ? "∞"
                                   : std::to_string(fit->second.maxArgs);
          std::string range = fit->second.minArgs == fit->second.maxArgs
                                  ? std::to_string(fit->second.minArgs)
                                  : std::to_string(fit->second.minArgs) + "–" + maxStr;
          throw ExpressionError(name + "() expects " + range + " argument(s), got " +
                                    std::to_string(got),
                                t.pos, "badArgCount");
        }
        auto n = std::make_shared<Node>();
        n->kind = NodeKind::Call;
        n->name = upper;
        n->children = std::move(args);
        return n;
      }
      auto cit = columns.find(toLower(name));
      if (cit == columns.end()) {
        throw ExpressionError("Unknown column '" + name + "'", t.pos, "unknownColumn");
      }
      auto n = std::make_shared<Node>();
      n->kind = NodeKind::Column;
      n->column = cit->second;
      n->columnName = name;
      return n;
    }
    if (t.type == Tok::LParen) {
      advance();
      NodePtr expr = parseExpression();
      if (peek().type != Tok::RParen) {
        throw ExpressionError("Expected ')'", peek().pos, "expectedClose");
      }
      advance();
      return expr;
    }
    std::string shown = t.value.empty() ? tokName(t.type) : t.value;
    throw ExpressionError("Unexpected token '" + shown + "'", t.pos, "unexpectedToken");
  }

  static std::string tokName(Tok ty) {
    switch (ty) {
      case Tok::Eof: return "eof";
      case Tok::RParen: return ")";
      case Tok::Comma: return ",";
      default: return "?";
    }
  }

  static inline const std::unordered_set<std::string> kBinaryOps = {
      "+", "-", "*", "/", "%", "^", ">", "<", ">=", "<=", "==", "!="};
};

NodePtr parseAst(const std::vector<Token>& tokens,
                 const std::unordered_map<std::string, int>& columns) {
  Parser p{tokens, columns};
  NodePtr ast = p.parseExpression();
  if (p.peek().type != Tok::Eof) {
    throw ExpressionError("Unexpected token '" + p.peek().value + "' after expression",
                          p.peek().pos, "trailingToken");
  }
  return ast;
}

// ── evaluator (mirrors compileAST(); arrays are full-length columns) ────

using EvalFn = std::function<std::vector<double>(const std::vector<std::vector<double>>&, size_t)>;

double sumFinite(const std::vector<double>& v) {
  double s = 0;
  for (double x : v)
    if (std::isfinite(x)) s += x;
  return s;
}

size_t countFinite(const std::vector<double>& v) {
  size_t n = 0;
  for (double x : v)
    if (std::isfinite(x)) ++n;
  return n;
}

double meanFinite(const std::vector<double>& v) {
  size_t n = countFinite(v);
  return n > 0 ? sumFinite(v) / static_cast<double>(n) : NAN;
}

EvalFn compileAst(const NodePtr& node) {
  switch (node->kind) {
    case NodeKind::Number: {
      double v = node->number;
      return [v](const std::vector<std::vector<double>>&, size_t len) {
        return std::vector<double>(len, v);
      };
    }
    case NodeKind::Column: {
      int idx = node->column;
      return [idx](const std::vector<std::vector<double>>& cols, size_t) { return cols[idx]; };
    }
    case NodeKind::Unary: {
      EvalFn inner = compileAst(node->children[0]);
      return [inner](const std::vector<std::vector<double>>& cols, size_t len) {
        std::vector<double> v = inner(cols, len);
        for (auto& x : v) x = -x;
        return v;
      };
    }
    case NodeKind::Binary: {
      EvalFn l = compileAst(node->children[0]);
      EvalFn r = compileAst(node->children[1]);
      std::string op = node->op;
      return [l, r, op](const std::vector<std::vector<double>>& cols, size_t len) {
        std::vector<double> a = l(cols, len);
        std::vector<double> b = r(cols, len);
        std::vector<double> out(len);
        for (size_t i = 0; i < len; ++i) {
          double x = a[i], y = b[i];
          if (op == "+") out[i] = x + y;
          else if (op == "-") out[i] = x - y;
          else if (op == "*") out[i] = x * y;
          else if (op == "/") out[i] = x / y;
          else if (op == "%") out[i] = std::fmod(x, y);
          else if (op == "^") out[i] = jsPow(x, y);
          else if (op == ">") out[i] = x > y ? 1.0 : 0.0;
          else if (op == "<") out[i] = x < y ? 1.0 : 0.0;
          else if (op == ">=") out[i] = x >= y ? 1.0 : 0.0;
          else if (op == "<=") out[i] = x <= y ? 1.0 : 0.0;
          else if (op == "==") out[i] = x == y ? 1.0 : 0.0;
          else if (op == "!=") out[i] = x != y ? 1.0 : 0.0;
          else out[i] = NAN;
        }
        return out;
      };
    }
    case NodeKind::Call: {
      std::vector<EvalFn> argFns;
      for (const auto& a : node->children) argFns.push_back(compileAst(a));
      const std::string name = node->name;

      // Aggregation: reduce to scalar then broadcast. MIN/MAX multi-arg fall through to
      // element-wise (same rule as the TS side).
      bool isMultiMinMax = (name == "MIN" || name == "MAX") && argFns.size() > 1;
      if (aggregationNames().count(name) && !isMultiMinMax) {
        EvalFn inner = argFns[0];
        return [inner, name](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> v = inner(cols, len);
          double scalar = NAN;
          if (name == "SUM") scalar = sumFinite(v);
          else if (name == "AVG" || name == "MEAN") scalar = meanFinite(v);
          else if (name == "MIN") {
            double m = INFINITY;
            for (double x : v)
              if (std::isfinite(x) && x < m) m = x;
            scalar = m == INFINITY ? NAN : m;
          } else if (name == "MAX") {
            double m = -INFINITY;
            for (double x : v)
              if (std::isfinite(x) && x > m) m = x;
            scalar = m == -INFINITY ? NAN : m;
          } else if (name == "MEDIAN") {
            std::vector<double> sorted;
            for (double x : v)
              if (std::isfinite(x)) sorted.push_back(x);
            std::sort(sorted.begin(), sorted.end());
            size_t mid = sorted.size() / 2;
            if (sorted.empty()) scalar = NAN;
            else if (sorted.size() % 2) scalar = sorted[mid];
            else scalar = (sorted[mid - 1] + sorted[mid]) / 2.0;
          } else if (name == "STD") {
            size_t n = countFinite(v);
            double mean = n > 0 ? sumFinite(v) / static_cast<double>(n) : NAN;
            double ss = 0;
            for (double x : v)
              if (std::isfinite(x)) ss += (x - mean) * (x - mean);
            scalar = n > 1 ? std::sqrt(ss / static_cast<double>(n - 1)) : 0.0;
          }
          return std::vector<double>(len, scalar);
        };
      }

      if (isMultiMinMax) {
        bool wantMin = name == "MIN";
        return [argFns, wantMin](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<std::vector<double>> arrays;
          for (const auto& fn : argFns) arrays.push_back(fn(cols, len));
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) {
            double result = arrays[0][i];
            for (size_t a = 1; a < arrays.size(); ++a) {
              // jsMin/jsMax carry the Math.min/Math.max semantics the TS reference relies
              // on (NaN wins, ±0 ordered) — std::min/max returned the non-NaN operand
              // whenever the NaN came second, so MIN(EXP(8.96), LN(B)) yielded 7785.36
              // instead of NaN. Found by the differential fuzz gate.
              result = wantMin ? jsMin(result, arrays[a][i]) : jsMax(result, arrays[a][i]);
            }
            out[i] = result;
          }
          return out;
        };
      }

      if (name == "ABS" || name == "SQRT" || name == "LOG" || name == "LN" ||
          name == "LOG10" || name == "EXP" || name == "POW" || name == "FLOOR" ||
          name == "CEIL" || name == "SIGN" || name == "ROUND") {
        return [argFns, name](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<std::vector<double>> arrays;
          for (const auto& fn : argFns) arrays.push_back(fn(cols, len));
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) {
            double a0 = arrays[0][i];
            double a1 = arrays.size() > 1 ? arrays[1][i] : 0.0;
            if (name == "ABS") out[i] = std::fabs(a0);
            else if (name == "SQRT") out[i] = std::sqrt(a0);
            else if (name == "LOG" || name == "LN") out[i] = std::log(a0);
            else if (name == "LOG10") out[i] = std::log10(a0);
            else if (name == "EXP") out[i] = std::exp(a0);
            else if (name == "POW") out[i] = jsPow(a0, a1);
            else if (name == "FLOOR") out[i] = std::floor(a0);
            else if (name == "CEIL") out[i] = std::ceil(a0);
            else if (name == "SIGN") {
              // Must match Math.sign exactly (the TS side is the reference): NaN → NaN,
              // ±0 → ±0, otherwise ±1. The previous `(a0 > 0) - (a0 < 0)` returned 0 for
              // NaN (both comparisons false), silently breaking NaN propagation — found by
              // the differential fuzz (diff_fuzz gate), not by the hand-written fixtures.
              if (std::isnan(a0) || a0 == 0.0) out[i] = a0;
              else out[i] = (a0 > 0) - (a0 < 0);
            }
            else if (name == "ROUND") {
              // Faithful port of the TS reference `Math.round(v * f) / f` with `f = 10 ** d`:
              // the exponent is used as-is (the previous static_cast<int> truncated
              // fractional digits — ROUND(6.66, 6.62) diverged), and the rounding must be
              // Math.round, not std::round (see jsRound).
              const double f = jsPow(10.0, a1);
              out[i] = jsRound(a0 * f) / f;
            }
          }
          return out;
        };
      }

      if (name == "MOV") {
        EvalFn dataFn = argFns[0];
        EvalFn windowFn = argFns[1];
        return [dataFn, windowFn](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> data = dataFn(cols, len);
          // Faithful port of the TS reference, which stays in doubles end to end:
          // `const w = Math.round(x); if (w <= 1) return data; const half = Math.floor(w/2);`
          // with `lo = Math.max(0, j-half)` and `hi = Math.min(len, j+half+1)`.
          // Using llround() here was undefined behaviour for a non-finite window
          // (llround(NaN/±Inf) is unspecified; on x86 it returned LLONG_MIN, so `w <= 1`
          // held and the smoothing silently became a no-op while the TS side averaged the
          // whole series). A NaN window must also yield NaN cells, exactly like the TS side.
          const double w = jsRound(windowFn(cols, len)[0]);
          if (w <= 1) return data;  // NaN compares false and falls through, as in the TS side
          const double half = std::floor(w / 2);
          std::vector<double> out(len);
          for (size_t j = 0; j < len; ++j) {
            const double jd = static_cast<double>(j);
            const double lo = jsMax(0.0, jd - half);
            const double hi = jsMin(static_cast<double>(len), jd + half + 1);
            double sum = 0;
            for (double k = lo; k < hi; k += 1.0) sum += data[static_cast<size_t>(k)];
            out[j] = sum / (hi - lo);  // NaN window → NaN/(NaN) → NaN, matching the TS side
          }
          return out;
        };
      }

      if (name == "EMA") {
        EvalFn dataFn = argFns[0];
        EvalFn alphaFn = argFns[1];
        return [dataFn, alphaFn](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> data = dataFn(cols, len);
          double alpha = alphaFn(cols, len)[0];
          std::vector<double> out(len);
          if (len == 0) return out;
          out[0] = data[0];
          for (size_t i = 1; i < len; ++i) out[i] = alpha * data[i] + (1 - alpha) * out[i - 1];
          return out;
        };
      }

      if (name == "IF") {
        EvalFn condFn = argFns[0], trueFn = argFns[1], falseFn = argFns[2];
        return [condFn, trueFn, falseFn](const std::vector<std::vector<double>>& cols, size_t len) {
          std::vector<double> cond = condFn(cols, len);
          std::vector<double> tv = trueFn(cols, len);
          std::vector<double> fv = falseFn(cols, len);
          std::vector<double> out(len);
          for (size_t i = 0; i < len; ++i) out[i] = cond[i] != 0.0 ? tv[i] : fv[i];
          return out;
        };
      }

      return [](const std::vector<std::vector<double>>&, size_t) { return std::vector<double>{}; };
    }
  }
  return nullptr;
}

std::unordered_map<std::string, int> buildColumnMap(const std::vector<std::string>& names) {
  std::unordered_map<std::string, int> map;
  for (size_t i = 0; i < names.size(); ++i) {
    map[toLower(names[i])] = static_cast<int>(i);
    if (names[i].rfind("Pos.", 0) == 0) {
      // "Pos.N" is additionally addressable by its number ("1", "2").
      map[toLower(names[i].substr(4))] = static_cast<int>(i);
      // A labelled column also registers under its bare annotation: the display label is
      // "Pos.1 A", but formulas refer to it as `A` — the same convention the TS reference
      // engine and the old browser evaluator used. Without this, an annotated multi-column
      // table was unaddressable by name (the whole "Pos.1 A" became one key containing a
      // space). Additive only: never overwrites an existing key, so first-wins ordering and
      // every previously resolvable formula are unchanged.
      const size_t space = names[i].find(' ');
      if (space != std::string::npos && space + 1 < names[i].size()) {
        const std::string anno = toLower(names[i].substr(space + 1));
        if (!anno.empty() && map.find(anno) == map.end()) map[anno] = static_cast<int>(i);
      }
    }
  }
  return map;
}

void collectRefs(const NodePtr& node, std::vector<std::string>* out) {
  if (!node) return;
  switch (node->kind) {
    case NodeKind::Column:
      if (std::find(out->begin(), out->end(), node->columnName) == out->end())
        out->push_back(node->columnName);
      break;
    case NodeKind::Binary:
    case NodeKind::Call:
      for (const auto& c : node->children) collectRefs(c, out);
      break;
    case NodeKind::Unary:
      collectRefs(node->children[0], out);
      break;
    case NodeKind::Number:
      break;
  }
}

}  // namespace

std::vector<double> ExprEngine::evaluate(const std::string& expression,
                                         const std::vector<std::string>& columnNames,
                                         const std::vector<std::vector<double>>& columns,
                                         size_t length) {
  auto tokens = tokenize(expression);
  auto colMap = buildColumnMap(columnNames);
  NodePtr ast = parseAst(tokens, colMap);
  EvalFn fn = compileAst(ast);
  return fn(columns, length);
}

std::vector<std::string> ExprEngine::references(const std::string& expression,
                                                const std::vector<std::string>& columnNames) {
  auto tokens = tokenize(expression);
  auto colMap = buildColumnMap(columnNames);
  NodePtr ast = parseAst(tokens, colMap);
  std::vector<std::string> refs;
  collectRefs(ast, &refs);
  return refs;
}

// ── matrix-mode evaluator ──────────────────────────────────────────────
// Parallel AST walker that produces MatVal instead of vector<double>.
// Reuses the same tokenizer/parser/AST; only the evaluation semantics differ.

namespace {

using MatEvalFn = std::function<MatVal(const std::vector<MatVal>&)>;

MatEvalFn compileAstMatrix(const NodePtr& node) {
  switch (node->kind) {
    case NodeKind::Number: {
      double v = node->number;
      return [v](const std::vector<MatVal>&) {
        return MatVal(Eigen::MatrixXd::Constant(1, 1, v));
      };
    }
    case NodeKind::Column: {
      int idx = node->column;
      return [idx](const std::vector<MatVal>& inputs) { return inputs[idx]; };
    }
    case NodeKind::Unary: {
      MatEvalFn inner = compileAstMatrix(node->children[0]);
      return [inner](const std::vector<MatVal>& inputs) {
        return MatVal::negate(inner(inputs));
      };
    }
    case NodeKind::Binary: {
      MatEvalFn l = compileAstMatrix(node->children[0]);
      MatEvalFn r = compileAstMatrix(node->children[1]);
      std::string op = node->op;
      return [l, r, op](const std::vector<MatVal>& inputs) {
        MatVal a = l(inputs);
        MatVal b = r(inputs);
        if (op == "+") return MatVal::add(a, b);
        if (op == "-") return MatVal::sub(a, b);
        if (op == "*") return MatVal::matmul(a, b);  // matrix mode: * = matmul
        if (op == "/") return MatVal::divElementwise(a, b);
        if (op == "%") return MatVal::modElementwise(a, b);
        if (op == "^") return MatVal::powElementwise(a, b);
        // Comparisons in matrix mode: element-wise, result is 0/1 matrix.
        auto cmpOp = [&](const std::function<bool(double,double)>& fn) {
          int64_t rows, cols;
          MatVal::broadcastShapes(a, b, &rows, &cols);
          Eigen::MatrixXd r(rows, cols);
          for (int64_t i = 0; i < rows; ++i)
            for (int64_t j = 0; j < cols; ++j)
              r(i,j) = fn(a.eigen()(i,j), b.eigen()(i,j)) ? 1.0 : 0.0;
          return MatVal(r);
        };
        if (op == ">")  return cmpOp([](double x, double y){ return x > y; });
        if (op == "<")  return cmpOp([](double x, double y){ return x < y; });
        if (op == ">=") return cmpOp([](double x, double y){ return x >= y; });
        if (op == "<=") return cmpOp([](double x, double y){ return x <= y; });
        if (op == "==") return cmpOp([](double x, double y){ return x == y; });
        if (op == "!=") return cmpOp([](double x, double y){ return x != y; });
        return MatVal();
      };
    }
    case NodeKind::Call: {
      std::vector<MatEvalFn> argFns;
      for (const auto& a : node->children) argFns.push_back(compileAstMatrix(a));
      const std::string name = node->name;

      // Matrix-specific functions.
      if (name == "TRANSPOSE") {
        MatEvalFn inner = argFns[0];
        return [inner](const std::vector<MatVal>& inputs) {
          return MatVal::transpose(inner(inputs));
        };
      }
      if (name == "DET") {
        MatEvalFn inner = argFns[0];
        return [inner](const std::vector<MatVal>& inputs) {
          double d = MatVal::determinant(inner(inputs));
          return MatVal(Eigen::MatrixXd::Constant(1, 1, d));
        };
      }
      if (name == "INV") {
        MatEvalFn inner = argFns[0];
        return [inner](const std::vector<MatVal>& inputs) {
          return MatVal::inverse(inner(inputs));
        };
      }
      if (name == "SOLVE") {
        MatEvalFn aFn = argFns[0], bFn = argFns[1];
        return [aFn, bFn](const std::vector<MatVal>& inputs) {
          return MatVal::solve(aFn(inputs), bFn(inputs));
        };
      }
      if (name == "MMUL") {
        MatEvalFn aFn = argFns[0], bFn = argFns[1];
        return [aFn, bFn](const std::vector<MatVal>& inputs) {
          return MatVal::matmul(aFn(inputs), bFn(inputs));
        };
      }
      if (name == "EMUL") {
        // Explicit element-wise multiply (for when * means matmul).
        MatEvalFn aFn = argFns[0], bFn = argFns[1];
        return [aFn, bFn](const std::vector<MatVal>& inputs) {
          return MatVal::mulElementwise(aFn(inputs), bFn(inputs));
        };
      }

      // Aggregations in matrix mode: reduce entire matrix to scalar, broadcast as 1×1.
      if (aggregationNames().count(name) && !((name == "MIN" || name == "MAX") && argFns.size() > 1)) {
        MatEvalFn inner = argFns[0];
        return [inner, name](const std::vector<MatVal>& inputs) {
          MatVal m = inner(inputs);
          const auto& e = m.eigen();
          double scalar = NAN;
          if (name == "SUM") {
            scalar = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) scalar += e(i,j);
          } else if (name == "AVG" || name == "MEAN") {
            double s = 0; int64_t n = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) { s += e(i,j); ++n; }
            scalar = n > 0 ? s / n : NAN;
          } else if (name == "MIN") {
            double mv = INFINITY;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j)) && e(i,j) < mv) mv = e(i,j);
            scalar = mv == INFINITY ? NAN : mv;
          } else if (name == "MAX") {
            double mv = -INFINITY;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j)) && e(i,j) > mv) mv = e(i,j);
            scalar = mv == -INFINITY ? NAN : mv;
          } else if (name == "MEDIAN") {
            std::vector<double> sorted;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) sorted.push_back(e(i,j));
            std::sort(sorted.begin(), sorted.end());
            size_t mid = sorted.size() / 2;
            scalar = sorted.empty() ? NAN
                   : sorted.size() % 2 ? sorted[mid]
                   : (sorted[mid-1] + sorted[mid]) / 2.0;
          } else if (name == "STD") {
            double s = 0; int64_t n = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) { s += e(i,j); ++n; }
            double mean = n > 0 ? s / n : NAN;
            double ss = 0;
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                if (std::isfinite(e(i,j))) ss += (e(i,j) - mean) * (e(i,j) - mean);
            scalar = n > 1 ? std::sqrt(ss / (n - 1)) : 0.0;
          }
          return MatVal(Eigen::MatrixXd::Constant(1, 1, scalar));
        };
      }

      // Element-wise math functions applied to every element of the matrix.
      if (name == "ABS" || name == "SQRT" || name == "LOG" || name == "LN" ||
          name == "LOG10" || name == "EXP" || name == "FLOOR" || name == "CEIL" ||
          name == "SIGN" || name == "ROUND" || name == "POW") {
        return [argFns, name](const std::vector<MatVal>& inputs) {
          MatVal m = argFns[0](inputs);
          const auto& e = m.eigen();
          Eigen::MatrixXd r(e.rows(), e.cols());
          if (name == "POW") {
            MatVal exp = argFns[1](inputs);
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                r(i,j) = jsPow(e(i,j), exp.isScalar() ? exp.scalar() : exp.eigen()(i,j));
          } else if (name == "ROUND") {
            double f = 1.0;
            if (argFns.size() > 1) {
              MatVal d = argFns[1](inputs);
              f = jsPow(10.0, d.scalar());  // exponent as-is, matching the TS reference
            }
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                r(i,j) = jsRound(e(i,j) * f) / f;
          } else {
            auto fn = [&](double v) -> double {
              if (name == "ABS") return std::fabs(v);
              if (name == "SQRT") return std::sqrt(v);
              if (name == "LOG" || name == "LN") return std::log(v);
              if (name == "LOG10") return std::log10(v);
              if (name == "EXP") return std::exp(v);
              if (name == "FLOOR") return std::floor(v);
              if (name == "CEIL") return std::ceil(v);
              if (name == "SIGN") return (std::isnan(v) || v == 0.0) ? v : static_cast<double>((v > 0) - (v < 0));
              return v;
            };
            for (int64_t i = 0; i < e.rows(); ++i)
              for (int64_t j = 0; j < e.cols(); ++j)
                r(i,j) = fn(e(i,j));
          }
          return MatVal(r);
        };
      }

      // IF in matrix mode: element-wise conditional over matrices.
      if (name == "IF") {
        MatEvalFn condFn = argFns[0], trueFn = argFns[1], falseFn = argFns[2];
        return [condFn, trueFn, falseFn](const std::vector<MatVal>& inputs) {
          MatVal c = condFn(inputs);
          MatVal t = trueFn(inputs);
          MatVal f = falseFn(inputs);
          int64_t rows = c.rows(), cols = c.cols();
          Eigen::MatrixXd r(rows, cols);
          for (int64_t i = 0; i < rows; ++i)
            for (int64_t j = 0; j < cols; ++j) {
              double cv = c.eigen()(i,j);
              double tv = t.isScalar() ? t.scalar() : t.eigen()(i,j);
              double fv = f.isScalar() ? f.scalar() : f.eigen()(i,j);
              r(i,j) = cv != 0.0 ? tv : fv;
            }
          return MatVal(r);
        };
      }

      // MOV/EMA not meaningful for matrices in v1; fall through to identity.
      return [](const std::vector<MatVal>&) { return MatVal(); };
    }
  }
  return nullptr;
}

}  // namespace

std::vector<double> ExprEngine::evaluateMatrix(
    const std::string& expression,
    const std::vector<std::string>& varNames,
    const std::vector<MatVal>& inputs,
    int64_t* outRows, int64_t* outCols) {
  // Build column map: varName → index. Matrix mode uses exact-case matching
  // (the variable declaration is explicit; no Pos.N aliasing needed).
  std::unordered_map<std::string, int> colMap;
  for (size_t i = 0; i < varNames.size(); ++i) {
    colMap[toLower(varNames[i])] = static_cast<int>(i);
  }
  auto tokens = tokenize(expression);
  NodePtr ast = parseAst(tokens, colMap);
  MatEvalFn fn = compileAstMatrix(ast);
  MatVal result = fn(inputs);
  *outRows = result.rows();
  *outCols = result.cols();
  return result.toColumnMajor();
}

}  // namespace dc
