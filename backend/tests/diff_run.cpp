// Differential-fuzz runner: reads a JSON case file (same judge format as the xlayer
// fixtures — {cases:[{name, columns:[{name,data}], expression}]}, non-finite cells as the
// "NaN"|"Infinity"|"-Infinity" string sentinels), evaluates every expression with the C++
// engine and prints one result object per case as JSON on stdout:
//   [{name, ok, values:[...], code, position, params:{...}}]
// The TS side (web/scripts/diff_fuzz.mjs) feeds identical cases and compares.
//
// `params` mirrors what the parser knows at the throw site (char/token/name/min/max/got)
// so the fuzz can diff structured error payloads, not just codes — the historical defect
// class lives on error paths. NaN must never leak into the JSON output, so non-finite
// results travel back as the same string sentinels the input uses.
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

double revive(const Json& v) {
  if (v.isNumber()) return v.asNumber();
  if (v.isString()) {
    const std::string& s = v.asString();
    if (s == "NaN") return NAN;
    if (s == "Infinity") return INFINITY;
    if (s == "-Infinity") return -INFINITY;
  }
  return 0;
}

std::string encodeNumber(double v) {
  if (std::isnan(v)) return "\"NaN\"";
  if (std::isinf(v)) return v > 0 ? "\"Infinity\"" : "\"-Infinity\"";
  char buf[40];
  std::snprintf(buf, sizeof buf, "%.17g", v);
  return buf;
}

// Structured params for an ExpressionError, keyed like the TS side's `params`.
Json errorParams(const ExpressionError& e) {
  Json p = Json::object();
  // The C++ message embeds the offending identity in quotes: "Unknown column 'X'".
  const std::string msg = e.what();
  const size_t q1 = msg.find('\'');
  const size_t q2 = q1 == std::string::npos ? std::string::npos : msg.find('\'', q1 + 1);
  const std::string quoted = (q1 != std::string::npos && q2 != std::string::npos)
                                 ? msg.substr(q1 + 1, q2 - q1 - 1)
                                 : std::string();
  if (e.code == "unknownColumn" || e.code == "unknownFunction") p.set("name", Json(quoted));
  else if (e.code == "unexpectedChar") p.set("char", Json(quoted));
  else if (e.code == "unexpectedToken" || e.code == "trailingToken") p.set("token", Json(quoted));
  else if (e.code == "badArgCount") {
    p.set("name", Json(quoted));
    // "... expects 2–3 argument(s), got 1"
    const size_t ex = msg.find("expects ");
    const size_t got = msg.rfind(", got ");
    if (ex != std::string::npos) {
      const size_t sp = msg.find(' ', ex + 8);
      p.set("expected", Json(msg.substr(ex + 8, sp == std::string::npos ? std::string::npos : sp - ex - 8)));
    }
    if (got != std::string::npos) p.set("got", Json(msg.substr(got + 6)));
  }
  return p;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: dc_diff_run <cases.json>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  if (!in) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }
  std::stringstream ss;
  ss << in.rdbuf();
  Json root;
  std::string err;
  if (!Json::parse(ss.str(), &root, &err)) {
    std::fprintf(stderr, "bad json: %s\n", err.c_str());
    return 2;
  }

  std::string out = "[";
  bool first = true;
  for (const auto& c : root["cases"].items()) {
    std::vector<std::string> names;
    std::vector<std::vector<double>> data;
    size_t length = 0;
    for (const auto& col : c["columns"].items()) {
      names.push_back(col["name"].asString());
      std::vector<double> v;
      for (const auto& x : col["data"].items()) v.push_back(revive(x));
      length = std::max(length, v.size());
      data.push_back(std::move(v));
    }
    if (!first) out += ",";
    first = false;

    bool ok = false;
    std::string code;
    long long pos = -999;
    std::string vals;
    Json params = Json::object();
    try {
      const auto got = ExprEngine::evaluate(c["expression"].asString(), names, data,
                                            length == 0 ? 1 : length);
      ok = true;
      for (size_t i = 0; i < got.size(); ++i) {
        if (i) vals += ",";
        vals += encodeNumber(got[i]);
      }
    } catch (const ExpressionError& e) {
      code = e.code;
      pos = static_cast<long long>(e.position);
      params = errorParams(e);
    } catch (const std::exception&) {
      code = "cppStdException";
      pos = -999;
    }
    out += "{\"name\":\"" + c["name"].asString() + "\",\"ok\":" + (ok ? "true" : "false") +
           ",\"values\":[" + vals + "],\"code\":\"" + code + "\",\"position\":" +
           std::to_string(pos) + ",\"params\":" + params.dump() + "}";
  }
  out += "]";
  std::printf("%s", out.c_str());
  return 0;
}
