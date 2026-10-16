// Runs the shared xlayer fixtures (web/tests/fixtures/xlayer/*.json) through the C++
// engine. Same judge as web/tests/xlayerFixtures.test.ts — CI requires both green.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "expression.h"
#include "json.h"

using namespace dc;

namespace {

double revive(const Json& v, bool* ok) {
  *ok = true;
  if (v.isNumber()) return v.asNumber();
  if (v.isString()) {
    const std::string& s = v.asString();
    if (s == "NaN") return NAN;
    if (s == "Infinity") return INFINITY;
    if (s == "-Infinity") return -INFINITY;
  }
  *ok = false;
  return 0;
}

bool sameNumber(double a, double b, double tol) {
  if (std::isnan(a) && std::isnan(b)) return true;
  if (!std::isfinite(a) || !std::isfinite(b)) return a == b;
  return std::fabs(a - b) <= tol;
}

int runFile(const std::string& path) {
  std::ifstream in(path);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", path.c_str());
    return 2;
  }
  std::stringstream ss;
  ss << in.rdbuf();
  Json root;
  std::string err;
  if (!Json::parse(ss.str(), &root, &err)) {
    std::fprintf(stderr, "bad fixture JSON: %s\n", err.c_str());
    return 2;
  }

  int passed = 0, failed = 0;
  for (const auto& c : root["cases"].items()) {
    const std::string name = c["name"].asString();
    std::vector<std::string> names;
    std::vector<std::vector<double>> data;
    size_t length = 0;
    for (const auto& col : c["columns"].items()) {
      names.push_back(col["name"].asString());
      std::vector<double> values;
      for (const auto& v : col["data"].items()) {
        bool ok = false;
        double d = revive(v, &ok);
        if (!ok) {
          std::printf("FAIL %-24s bad column sentinel\n", name.c_str());
          ++failed;
          goto nextCase;
        }
        values.push_back(d);
      }
      length = std::max(length, values.size());
      data.push_back(std::move(values));
    }

    if (!c["error"].isNull()) {
      const std::string wantCode = c["error"]["code"].asString();
      try {
        ExprEngine::evaluate(c["expression"].asString(), names, data, length == 0 ? 1 : length);
        std::printf("FAIL %-24s expected error %s, got none\n", name.c_str(), wantCode.c_str());
        ++failed;
      } catch (const ExpressionError& e) {
        if (e.code != wantCode) {
          std::printf("FAIL %-24s expected code %s, got %s (%s)\n", name.c_str(),
                      wantCode.c_str(), e.code.c_str(), e.what());
          ++failed;
        } else if (c["error"]["position"].isNumber() &&
                   e.position != static_cast<int64_t>(c["error"]["position"].asNumber())) {
          std::printf("FAIL %-24s expected position %lld, got %lld\n", name.c_str(),
                      static_cast<long long>(c["error"]["position"].asNumber()),
                      static_cast<long long>(e.position));
          ++failed;
        } else {
          ++passed;
        }
      }
      continue;
    }

    try {
      std::vector<double> got =
          ExprEngine::evaluate(c["expression"].asString(), names, data, length == 0 ? 1 : length);
      const std::vector<Json>& wantJson = c["expect"].items();
      double tol = c["tol"].isNumber() ? c["tol"].asNumber() : 0.0;
      if (got.size() != wantJson.size()) {
        std::printf("FAIL %-24s length %zu != %zu\n", name.c_str(), got.size(), wantJson.size());
        ++failed;
        continue;
      }
      bool caseOk = true;
      for (size_t i = 0; i < wantJson.size(); ++i) {
        bool ok = false;
        double w = revive(wantJson[i], &ok);
        if (!ok || !sameNumber(got[i], w, tol)) {
          std::printf("FAIL %-24s [%zu] got %.17g want %.17g\n", name.c_str(), i, got[i], w);
          caseOk = false;
          break;
        }
      }
      if (caseOk) ++passed;
      else ++failed;
    } catch (const ExpressionError& e) {
      std::printf("FAIL %-24s unexpected error %s at %lld (%s)\n", name.c_str(), e.code.c_str(),
                  static_cast<long long>(e.position), e.what());
      ++failed;
    }
  nextCase:;
  }

  std::printf("%s: %d passed, %d failed (%s)\n", failed == 0 ? "PASS" : "FAILED", passed, failed,
              path.c_str());
  return failed == 0 ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: dc_fixture_run <fixture.json> [...]\n");
    return 2;
  }
  int worst = 0;
  for (int i = 1; i < argc; ++i) worst = std::max(worst, runFile(argv[i]));
  return worst;
}
