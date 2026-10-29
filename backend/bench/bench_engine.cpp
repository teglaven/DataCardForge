// dc_bench — 引擎层性能门禁（决策见 docs/docs/decisions/2026-10-29-perf-gate.md）。
//
// 直接调 ExprEngine::evaluate（逐元素）与 ExprEngine::evaluateMatrix（矩阵），不经 HTTP、
// 不起服务、不读真实数据文件：测的是「公式 + 数据 → 结果」这条路径本身，不是外面那层传输。
//
// 用法（仓库根或 backend/build 里都能跑）：
//   DC_RUN_BENCH=1 ./dc_bench                     # 带 budgets.json + baseline.json 跑，全绿 exit 0
//   DC_RUN_BENCH=1 ./dc_bench --update-baseline   # 第一遍：只取基线，写 bench/baseline.json
//   DC_RUN_BENCH=1 ./dc_bench --case elem.k5 --json /tmp/o.json
//   ./dc_bench                                    # 没设 DC_RUN_BENCH → exit 101（ctest 记 SKIP）
//
// 计时口径：每例先 warmup 3 次（丢弃），再测 N 次（逐元素 15、矩阵 5），报 p50 / p95
// （毫秒，两位小数）。平均值会被一次调度抖动整段拖歪，中位数不会；p95 用线性插值，
// 不取「最大值」——单次抖动只会把它抬高一档，不会把门禁整体染红。开始测量前把进程钉在
// 当前 CPU 上（见 pinToCurrentCpu）：不钉的话短用例会被核心迁移抖到 20%，压着 1.3× 护栏。
//
// 数据：mt19937 固定种子 12345。逐元素列 a..f（名字与列映射的真实路径一致），矩阵变量 A/B/C
// （矩阵模式约定大写开头）。生成后逐值检查有限性与正规性（NaN / Inf / denormal 会让计时失真）。
// 512² 的 B/C 做成对角占优：只是让 DET / INV / SOLVE 数值良态，LU 的工作量与取值无关。
//
// 扩展方式（框架不改）：在下面的 cases() 里加一行（name / 是否矩阵 / 公式 / 变量），
// 再在 bench/budgets.json 的 cases 里给同名一条 "max_ms"。只有需要**新数据形状**时才动 buildData()。
//
// 退出码：0 全绿 / 1 超预算或超回归护栏 / 2 参数或数据错误 / 101 未启用（DC_RUN_BENCH≠1）。

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <string>
#include <vector>

#include <sys/stat.h>
// 测量卫生：把进程钉在它当前所在的那颗 CPU 上（见 pinToCurrentCpu）。
#include <sched.h>

#include "expression.h"
#include "matrix_value.h"

namespace {

using Clock = std::chrono::steady_clock;

// ── 尺子：尺寸 / 次数 ─────────────────────────────────────────────────────
constexpr size_t kElemLength = 100000;  // 目标数据形状：6 列 × 10 万行
constexpr int kElemCols = 6;
constexpr int kMatARows = 6;      // A/B/C 的「表」是 6 变量 × 10 万样本
constexpr int kMatACols = 100000;
constexpr int kSquare = 512;      // O(n³) 那一档的代表
constexpr int kElemIters = 15;
constexpr int kMatIters = 5;
constexpr int kWarmup = 3;

// 让编译器无法把整段求值当成死代码删掉（求值函数是外部符号，本来也删不掉；留着更明确）。
volatile double g_sink = 0.0;

struct Case {
  const char* name;
  bool matrix;
  std::vector<const char*> exprs;  // 一次计时跑完这里的所有表达式（elem.k5 就是 5 条）
  std::vector<const char*> vars;   // 矩阵模式用到的变量名
};

const std::vector<Case>& cases() {
  static const std::vector<Case> k = {
      {"elem.add", false, {"a + b * 2"}, {}},
      {"elem.sqrt", false, {"sqrt(a*a + b*b)"}, {}},
      {"elem.branch", false, {"IF(a > 0, a, -a)"}, {}},
      {"elem.aggregate", false, {"a / MEAN(a)"}, {}},
      {"elem.window", false, {"MOV(a, 5)"}, {}},
      // 真实路径：每条表达式都重走 tokenize / 建列映射 / 解析 / 编译，不缓存编译结果。
      {"elem.k5",
       false,
       {"a+b", "a*b+1", "sqrt(a*a+b*b)", "a/MEAN(a)", "IF(a>b,a,b)"},
       {}},
      {"mx.transpose", true, {"TRANSPOSE(A)"}, {"A"}},
      {"mx.mixed", true, {"A * TRANSPOSE(A)"}, {"A"}},
      {"mx.matmul", true, {"B * B"}, {"B"}},
      {"mx.inv", true, {"INV(B)"}, {"B"}},
      {"mx.det", true, {"DET(B)"}, {"B"}},
      {"mx.solve", true, {"SOLVE(B, C)"}, {"B", "C"}},
  };
  return k;
}

struct Data {
  std::vector<std::string> colNames;
  std::vector<std::vector<double>> cols;
  std::map<std::string, dc::MatVal> mats;
};

bool sane(const std::vector<double>& v, const char* what, std::string* err) {
  for (double x : v) {
    if (!std::isfinite(x)) {
      *err = std::string(what) + " 含 NaN/Inf";
      return false;
    }
    if (x != 0.0 && std::fpclassify(x) == FP_SUBNORMAL) {
      *err = std::string(what) + " 含 denormal";
      return false;
    }
  }
  return true;
}

bool buildData(Data* d, std::string* err) {
  std::mt19937 rng(12345);
  auto uni = [&rng](double lo, double hi) {
    return std::uniform_real_distribution<double>(lo, hi)(rng);
  };

  // 逐元素：6 列 × 10 万行，[-1,1]。b 走带符号取值，好让 IF 的两条手臂都走到。
  d->colNames = {"a", "b", "c", "d", "e", "f"};
  for (int c = 0; c < kElemCols; ++c) {
    std::vector<double> col(kElemLength);
    for (auto& v : col) v = uni(-1.0, 1.0);
    if (!sane(col, "逐元素列", err)) return false;
    d->cols.push_back(std::move(col));
  }

  // A：6 行 × 10 万列的「表」。
  std::vector<double> flatA(static_cast<size_t>(kMatARows) * kMatACols);
  for (int j = 0; j < kMatACols; ++j)
    for (int i = 0; i < kMatARows; ++i) flatA[static_cast<size_t>(j) * kMatARows + i] = uni(-1.0, 1.0);
  if (!sane(flatA, "矩阵 A", err)) return false;
  d->mats["A"] = dc::MatVal::fromFlat(flatA.data(), kMatARows, kMatACols);

  // B / C：512²，对角占优（对角 U(0.5,1.5)，非对角 ±0.001）。
  // 取值不改变 LU 的运算量，但能让 DET / INV / SOLVE 的结果留在有限、正规的范围内。
  for (const char* name : {"B", "C"}) {
    std::vector<double> flat(static_cast<size_t>(kSquare) * kSquare);
    for (int j = 0; j < kSquare; ++j)
      for (int i = 0; i < kSquare; ++i)
        flat[static_cast<size_t>(j) * kSquare + i] =
            (i == j) ? uni(0.5, 1.5) : uni(-0.001, 0.001);
    if (!sane(flat, name, err)) return false;
    d->mats[name] = dc::MatVal::fromFlat(flat.data(), kSquare, kSquare);
  }
  return true;
}

struct CaseInputs {
  std::vector<std::string> varNames;
  std::vector<dc::MatVal> matrices;
};

bool prepareCase(const Case& c, const Data& d, CaseInputs* in, std::string* err) {
  if (!c.matrix) return true;
  for (const char* v : c.vars) {
    auto it = d.mats.find(v);
    if (it == d.mats.end()) {
      *err = std::string("用例 ") + c.name + " 引用了未生成的数据 " + v;
      return false;
    }
    in->varNames.emplace_back(v);
    in->matrices.push_back(it->second);  // 只拷一次：计时区间内不再复制输入
  }
  return true;
}

double msSince(Clock::time_point t0, Clock::time_point t1) {
  return std::chrono::duration<double, std::milli>(t1 - t0).count();
}

// 线性插值分位数（numpy 默认口径）。15 个样本时 p95 落在第 14 名与最大值之间，
// 而不是直接等于最大值——否则一次调度抖动就把 p95 抬成「最坏那一趟」，门禁会假红。
double percentile(std::vector<double> samples, double q) {
  if (samples.empty()) return 0.0;
  std::sort(samples.begin(), samples.end());
  if (samples.size() == 1) return samples[0];
  const double pos = q * static_cast<double>(samples.size() - 1);
  const size_t lo = static_cast<size_t>(std::floor(pos));
  const size_t hi = static_cast<size_t>(std::ceil(pos));
  const double frac = pos - static_cast<double>(lo);
  return samples[lo] + (samples[hi] - samples[lo]) * frac;
}

bool measure(const Case& c, const Data& d, const CaseInputs& in, std::vector<double>* samples,
             std::string* err) {
  const int iters = c.matrix ? kMatIters : kElemIters;
  for (int i = 0; i < kWarmup + iters; ++i) {
    const auto t0 = Clock::now();
    try {
      double sink = 0.0;
      if (!c.matrix) {
        for (const char* e : c.exprs) {
          std::vector<double> out = dc::ExprEngine::evaluate(e, d.colNames, d.cols, kElemLength);
          sink += out.empty() ? 0.0 : out.front();
        }
      } else {
        for (const char* e : c.exprs) {
          int64_t rows = 0, cols = 0;
          std::vector<double> out = dc::ExprEngine::evaluateMatrix(e, in.varNames, in.matrices,
                                                                  &rows, &cols);
          sink += out.empty() ? 0.0 : out.front();
        }
      }
      g_sink = sink;
    } catch (const std::exception& e) {
      *err = std::string("用例 ") + c.name + " 求值失败: " + e.what();
      return false;
    }
    const auto t1 = Clock::now();
    if (i >= kWarmup) samples->push_back(msSince(t0, t1));
  }
  return true;
}

// ── 环境信息 ─────────────────────────────────────────────────────────────

// 测量卫生：把进程钉在当前 CPU 上。这台机器上不钉的话，调度器会在测量中途把进程迁到
// 另一颗核心，`elem.add`（0.19 ms 那一档）就在 0.19 / 0.23 之间来回跳——21% 的抖动正好压
// 在 1.3× 回归护栏上，门禁会假红。钉住之后同一颗核心、同一份产物，读数稳定到 1% 以内。
// 尽力而为：cpuset 不让改（容器）或非 Linux 时失败就照旧跑，不影响正确性。
int pinToCurrentCpu() {
  const int cpu = sched_getcpu();
  if (cpu < 0) return -1;
  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET(cpu, &set);
  if (sched_setaffinity(0, sizeof set, &set) != 0) return -1;
  return cpu;
}

std::string gitSha() {
  std::string out = "unknown";
  std::FILE* p = popen("git rev-parse --short HEAD 2>/dev/null", "r");
  if (!p) return out;
  char buf[64] = {0};
  if (std::fgets(buf, sizeof buf, p) != nullptr) {
    std::string s(buf);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    if (!s.empty()) out = s;
  }
  pclose(p);
  return out;
}

std::string machineName() {
  std::ifstream in("/proc/cpuinfo");
  std::string line;
  while (std::getline(in, line)) {
    if (line.rfind("model name", 0) == 0) {
      const size_t c = line.find(':');
      if (c != std::string::npos) {
        std::string v = line.substr(c + 1);
        const size_t first = v.find_first_not_of(" \t");
        if (first != std::string::npos) v.erase(0, first);
        if (!v.empty()) return v;
      }
    }
  }
  return "unknown";
}

std::string utcNow() {
  const std::time_t t = std::time(nullptr);
  std::tm tm{};
  gmtime_r(&t, &tm);
  char buf[32] = {0};
  std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buf;
}

bool dirExists(const std::string& p) {
  struct stat st {};
  return ::stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

// ctest 的 CWD 是 backend/build，人在仓库根跑则是 backend/bench：两处都要能找到 JSON。
std::string benchDir() {
  for (const char* cand : {"backend/bench", "bench", "../bench", "../../backend/bench"}) {
    if (dirExists(cand)) return cand;
  }
  return "backend/bench";
}

// ── 机器写、机器读的小 JSON 扫描器（不引第三方解析器）────────────────────
// 基线 / 预算都是本程序自己写出来的固定形状，读的时候按 case 名定位再取数字即可。

bool readText(const std::string& path, std::string* out) {
  std::ifstream in(path);
  if (!in) return false;
  out->assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  return true;
}

bool numberAfter(const std::string& text, size_t from, const char* key, double* out) {
  const size_t k = text.find(std::string("\"") + key + "\"", from);
  if (k == std::string::npos) return false;
  const size_t colon = text.find(':', k);
  if (colon == std::string::npos) return false;
  const char* s = text.c_str() + colon + 1;
  char* end = nullptr;
  const double v = std::strtod(s, &end);
  if (end == s) return false;
  *out = v;
  return true;
}

bool stringAfter(const std::string& text, const char* key, std::string* out) {
  const size_t k = text.find(std::string("\"") + key + "\"");
  if (k == std::string::npos) return false;
  const size_t colon = text.find(':', k);
  if (colon == std::string::npos) return false;
  const size_t q1 = text.find('"', colon);
  if (q1 == std::string::npos) return false;
  const size_t q2 = text.find('"', q1 + 1);
  if (q2 == std::string::npos) return false;
  *out = text.substr(q1 + 1, q2 - q1 - 1);
  return true;
}

std::string jsonEscape(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') {
      o.push_back('\\');
      o.push_back(c);
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned char>(c));
      o += buf;
    } else {
      o.push_back(c);
    }
  }
  return o;
}

struct Measurement {
  std::string name;
  bool matrix = false;
  int iters = 0;
  std::vector<double> samples;
  double p50 = 0.0;
  double p95 = 0.0;
};

std::string writeMeasurements(const std::string& path, const std::string& machine,
                              const std::string& git, const std::string& takenAt,
                              const std::vector<Measurement>& rows) {
  std::string out = "{\n";
  out += "  \"machine\": \"" + jsonEscape(machine) + "\",\n";
  out += "  \"git\": \"" + jsonEscape(git) + "\",\n";
  out += "  \"taken_at\": \"" + jsonEscape(takenAt) + "\",\n";
  out += "  \"cases\": {\n";
  for (size_t i = 0; i < rows.size(); ++i) {
    char buf[96];
    std::snprintf(buf, sizeof buf, "    \"%s\": { \"p50_ms\": %.2f, \"p95_ms\": %.2f }%s\n",
                  rows[i].name.c_str(), rows[i].p50, rows[i].p95,
                  i + 1 < rows.size() ? "," : "");
    out += buf;
  }
  out += "  }\n}\n";
  std::ofstream f(path);
  if (!f) return "无法写入 " + path;
  f << out;
  if (!f) return "无法写入 " + path;
  return "";
}

void usage(std::FILE* to) {
  std::fprintf(to,
               "用法: dc_bench [--update-baseline] [--case <name>] [--json <path>]\n"
               "               [--baseline <path>] [--budgets <path>]\n"
               "  需要 DC_RUN_BENCH=1 才会真的跑（否则 exit 101，ctest 记 SKIP）。\n");
}

}  // namespace

int main(int argc, char** argv) {
  bool updateBaseline = false;
  std::string caseFilter;
  std::string jsonPath;
  const std::string dir = benchDir();
  std::string baselinePath = dir + "/baseline.json";
  std::string budgetsPath = dir + "/budgets.json";

  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto needValue = [&](const char* what) -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "dc_bench: %s 后面缺参数\n", what);
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--update-baseline") {
      updateBaseline = true;
    } else if (a == "--case") {
      caseFilter = needValue("--case");
    } else if (a == "--json") {
      jsonPath = needValue("--json");
    } else if (a == "--baseline") {
      baselinePath = needValue("--baseline");
    } else if (a == "--budgets") {
      budgetsPath = needValue("--budgets");
    } else if (a == "--help" || a == "-h") {
      usage(stdout);
      return 0;
    } else {
      std::fprintf(stderr, "dc_bench: 不认识的参数 `%s`\n", a.c_str());
      usage(stderr);
      return 2;
    }
  }

  const char* run = std::getenv("DC_RUN_BENCH");
  if (run == nullptr || std::strcmp(run, "1") != 0) {
    std::fprintf(stderr,
                 "dc_bench: DC_RUN_BENCH=1 未设置，跳过性能门禁（opt-in，CI 保持快且确定）。\n");
    return 101;
  }

  const int pinnedCpu = pinToCurrentCpu();

  Data data;
  std::string err;
  if (!buildData(&data, &err)) {
    std::fprintf(stderr, "dc_bench: 数据生成失败: %s\n", err.c_str());
    return 2;
  }

  std::vector<const Case*> selected;
  if (caseFilter.empty()) {
    for (const Case& c : cases()) selected.push_back(&c);
  } else {
    for (const Case& c : cases()) {
      if (caseFilter == c.name) selected.push_back(&c);
    }
    if (selected.empty()) {
      std::fprintf(stderr, "dc_bench: 没有名为 `%s` 的用例。可用: ", caseFilter.c_str());
      for (const Case& c : cases()) std::fprintf(stderr, "%s ", c.name);
      std::fprintf(stderr, "\n");
      return 2;
    }
  }

  const std::string machine = machineName();
  const std::string git = gitSha();
  const std::string takenAt = utcNow();
  std::vector<Measurement> rows;
  rows.reserve(selected.size());
  for (const Case* c : selected) {
    CaseInputs in;
    if (!prepareCase(*c, data, &in, &err)) {
      std::fprintf(stderr, "dc_bench: %s\n", err.c_str());
      return 2;
    }
    Measurement m;
    m.name = c->name;
    m.matrix = c->matrix;
    m.iters = c->matrix ? kMatIters : kElemIters;
    if (!measure(*c, data, in, &m.samples, &err)) {
      std::fprintf(stderr, "dc_bench: %s\n", err.c_str());
      return 2;
    }
    m.p50 = percentile(m.samples, 0.50);
    m.p95 = percentile(m.samples, 0.95);
    rows.push_back(std::move(m));
  }

  if (updateBaseline) {
    const std::string writeErr = writeMeasurements(baselinePath, machine, git, takenAt, rows);
    if (!writeErr.empty()) {
      std::fprintf(stderr, "dc_bench: %s\n", writeErr.c_str());
      return 2;
    }
  }

  // 预算与回归：只在「带卡」模式下读；--update-baseline 是第一遍，还没有卡。
  std::vector<double> maxMs(rows.size(), 0.0);
  bool haveBudget = false;
  double ratioLimit = 1.3;
  std::map<std::string, double> baseP50;
  bool haveBaseline = false;
  if (!updateBaseline) {
    std::string budgetsText;
    if (!readText(budgetsPath, &budgetsText)) {
      std::fprintf(stderr, "dc_bench: 读不到预算 %s（先用 --update-baseline 取基线，再生成它）\n",
                   budgetsPath.c_str());
      return 2;
    }
    if (!numberAfter(budgetsText, 0, "regression_ratio", &ratioLimit)) {
      std::fprintf(stderr, "dc_bench: %s 缺 regression_ratio\n", budgetsPath.c_str());
      return 2;
    }
    for (size_t i = 0; i < rows.size(); ++i) {
      const size_t at = budgetsText.find("\"" + rows[i].name + "\"");
      if (at == std::string::npos || !numberAfter(budgetsText, at, "max_ms", &maxMs[i])) {
        std::fprintf(stderr, "dc_bench: %s 里没有 `%s` 的 max_ms\n", budgetsPath.c_str(),
                     rows[i].name.c_str());
        return 2;
      }
    }
    haveBudget = true;

    std::string baselineText;
    if (!readText(baselinePath, &baselineText)) {
      std::fprintf(stderr, "dc_bench: 读不到基线 %s（先跑 --update-baseline）\n",
                   baselinePath.c_str());
      return 2;
    }
    for (const Measurement& m : rows) {
      const size_t at = baselineText.find("\"" + m.name + "\"");
      double v = 0.0;
      if (at == std::string::npos || !numberAfter(baselineText, at, "p50_ms", &v)) {
        std::fprintf(stderr, "dc_bench: %s 里没有 `%s` 的 p50_ms\n", baselinePath.c_str(),
                     m.name.c_str());
        return 2;
      }
      baseP50[m.name] = v;
    }
    haveBaseline = true;
    std::string baseMachine;
    if (stringAfter(baselineText, "machine", &baseMachine) && baseMachine != machine) {
      std::fprintf(stderr,
                   "dc_bench: 注意——基线取自另一台机器（%s），回归比对仅供参考，预算仍按本机判。\n",
                   baseMachine.c_str());
    }
  }

  std::printf("== dc_bench（引擎层，不经 HTTP）==\n");
  std::printf("machine: %s\n", machine.c_str());
  std::printf("git: %s    at: %s    iters: 逐元素 %d / 矩阵 %d（另有 %d 次 warmup）\n",
              git.c_str(), takenAt.c_str(), kElemIters, kMatIters, kWarmup);
  if (pinnedCpu >= 0) {
    std::printf("cpu: 已钉在 CPU %d（防止测量中途迁移）\n", pinnedCpu);
  } else {
    std::printf("cpu: 未钉住（sched_setaffinity 不可用，读数会带迁移噪声）\n");
  }
  std::printf("%-16s %-8s %3s %9s %9s %8s %8s  %s\n", "case", "kind", "n", "p50_ms", "p95_ms",
              "max_ms", "vs_base", "status");
  std::printf("---------------------------------------------------------------------------------\n");

  bool anyFail = false;
  for (size_t i = 0; i < rows.size(); ++i) {
    const Measurement& m = rows[i];
    std::string status = "measured";
    char ratio[16] = "--";
    const bool overBudget = haveBudget && (m.p50 > maxMs[i] || m.p95 > maxMs[i]);
    double base = 0.0;
    bool overRegression = false;
    if (haveBaseline) {
      base = baseP50[m.name];
      if (base > 0.0) {
        std::snprintf(ratio, sizeof ratio, "%.2fx", m.p50 / base);
        overRegression = m.p50 / base > ratioLimit;
      }
    }
    if (updateBaseline) {
      status = "baseline";
    } else if (overBudget) {
      status = "budget!";
      anyFail = true;
    } else if (overRegression) {
      status = "regress!";
      anyFail = true;
    } else {
      status = "ok";
    }
    if (haveBudget) {
      std::printf("%-16s %-8s %3d %9.2f %9.2f %8.2f %8s  %s\n", m.name.c_str(),
                  m.matrix ? "matrix" : "element", m.iters, m.p50, m.p95, maxMs[i], ratio,
                  status.c_str());
    } else {
      std::printf("%-16s %-8s %3d %9.2f %9.2f %8s %8s  %s\n", m.name.c_str(),
                  m.matrix ? "matrix" : "element", m.iters, m.p50, m.p95, "--", "--",
                  status.c_str());
    }
  }
  std::printf("---------------------------------------------------------------------------------\n");

  if (!jsonPath.empty()) {
    const std::string writeErr = writeMeasurements(jsonPath, machine, git, takenAt, rows);
    if (!writeErr.empty()) {
      std::fprintf(stderr, "dc_bench: %s\n", writeErr.c_str());
      return 2;
    }
  }

  if (updateBaseline) {
    std::printf("基线已写入 %s（%zu 例）。下一步：按 p50 × 3 生成 budgets.json，再带卡跑一遍。\n",
                baselinePath.c_str(), rows.size());
    return 0;
  }

  if (anyFail) {
    std::printf("\n超预算 / 超回归护栏：\n");
    for (size_t i = 0; i < rows.size(); ++i) {
      const Measurement& m = rows[i];
      if (m.p50 > maxMs[i] || m.p95 > maxMs[i]) {
        std::printf("  - %s: p50 %.2f / p95 %.2f > max %.2f ms\n", m.name.c_str(), m.p50, m.p95,
                    maxMs[i]);
      } else {
        const double base = baseP50[m.name];
        if (base > 0.0 && m.p50 / base > ratioLimit) {
          std::printf("  - %s: p50 %.2f 是基线 %.2f 的 %.2fx（护栏 %.2fx）\n", m.name.c_str(), m.p50,
                      base, m.p50 / base, ratioLimit);
        }
      }
    }
    std::printf("门禁不过。按任务书：贴数字等裁决，不要当场改引擎。\n");
    return 1;
  }

  std::printf("全绿：%zu 例都在预算内（p50 与 p95），且 p50 未超基线 %.2fx。\n", rows.size(),
              ratioLimit);
  return 0;
}
