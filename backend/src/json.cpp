#include "json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <sstream>

namespace dc {

const Json* Json::find(const std::string& key) const {
  if (kind_ != Kind::Object) return nullptr;
  for (const auto& kv : members_)
    if (kv.first == key) return &kv.second;
  return nullptr;
}

const Json& Json::operator[](const std::string& key) const {
  static const Json kNull;
  const Json* v = find(key);
  return v ? *v : kNull;
}

void Json::set(const std::string& key, Json value) {
  for (auto& kv : members_) {
    if (kv.first == key) {
      kv.second = std::move(value);
      return;
    }
  }
  members_.emplace_back(key, std::move(value));
}

void Json::push(Json value) { items_.push_back(std::move(value)); }

// ── parser ─────────────────────────────────────────────────────────────

namespace {

struct Parser {
  const std::string& s;
  size_t i = 0;
  std::string err;

  explicit Parser(const std::string& text) : s(text) {}

  void skipWs() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
  }

  bool fail(const std::string& msg) {
    if (err.empty()) err = msg + " at position " + std::to_string(i);
    return false;
  }

  bool parseValue(Json* out, int depth);
  bool parseString(std::string* out);
};

bool Parser::parseString(std::string* out) {
  if (i >= s.size() || s[i] != '"') return fail("expected string");
  ++i;
  out->clear();
  while (true) {
    if (i >= s.size()) return fail("unterminated string");
    char c = s[i];
    if (c == '"') { ++i; return true; }
    if (c == '\\') {
      ++i;
      if (i >= s.size()) return fail("bad escape");
      char e = s[i++];
      switch (e) {
        case '"': out->push_back('"'); break;
        case '\\': out->push_back('\\'); break;
        case '/': out->push_back('/'); break;
        case 'b': out->push_back('\b'); break;
        case 'f': out->push_back('\f'); break;
        case 'n': out->push_back('\n'); break;
        case 'r': out->push_back('\r'); break;
        case 't': out->push_back('\t'); break;
        case 'u': {
          if (i + 4 > s.size()) return fail("bad \\u");
          unsigned cp = std::strtoul(s.substr(i, 4).c_str(), nullptr, 16);
          i += 4;
          // UTF-8 encode the BMP code point. Surrogate pairs are not produced by our
          // own dumps and JSON fixtures stay in BMP; a lone surrogate becomes U+FFFD.
          if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
          if (cp < 0x80) out->push_back(static_cast<char>(cp));
          else if (cp < 0x800) {
            out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          } else {
            out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          }
          break;
        }
        default: return fail("bad escape character");
      }
    } else {
      out->push_back(c);
      ++i;
    }
  }
}

bool Parser::parseValue(Json* out, int depth) {
  if (depth > 128) return fail("nesting too deep");
  skipWs();
  if (i >= s.size()) return fail("unexpected end");
  char c = s[i];
  if (c == '{') {
    ++i;
    std::vector<std::pair<std::string, Json>> members;
    skipWs();
    if (i < s.size() && s[i] == '}') { ++i; *out = Json::object(std::move(members)); return true; }
    while (true) {
      skipWs();
      std::string key;
      if (!parseString(&key)) return false;
      skipWs();
      if (i >= s.size() || s[i] != ':') return fail("expected ':'");
      ++i;
      Json value;
      if (!parseValue(&value, depth + 1)) return false;
      members.emplace_back(std::move(key), std::move(value));
      skipWs();
      if (i < s.size() && s[i] == ',') { ++i; continue; }
      if (i < s.size() && s[i] == '}') { ++i; break; }
      return fail("expected ',' or '}'");
    }
    *out = Json::object(std::move(members));
    return true;
  }
  if (c == '[') {
    ++i;
    std::vector<Json> items;
    skipWs();
    if (i < s.size() && s[i] == ']') { ++i; *out = Json::array(std::move(items)); return true; }
    while (true) {
      Json value;
      if (!parseValue(&value, depth + 1)) return false;
      items.push_back(std::move(value));
      skipWs();
      if (i < s.size() && s[i] == ',') { ++i; continue; }
      if (i < s.size() && s[i] == ']') { ++i; break; }
      return fail("expected ',' or ']'");
    }
    *out = Json::array(std::move(items));
    return true;
  }
  if (c == '"') {
    std::string str;
    if (!parseString(&str)) return false;
    *out = Json(std::move(str));
    return true;
  }
  if (c == 't') {
    if (s.compare(i, 4, "true") != 0) return fail("bad literal");
    i += 4; *out = Json(true); return true;
  }
  if (c == 'f') {
    if (s.compare(i, 5, "false") != 0) return fail("bad literal");
    i += 5; *out = Json(false); return true;
  }
  if (c == 'n') {
    if (s.compare(i, 4, "null") != 0) return fail("bad literal");
    i += 4; *out = Json(); return true;
  }
  // Number: JSON grammar (no NaN/Infinity — see json.h comment).
  size_t start = i;
  if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
  while (i < s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '.' ||
                          s[i] == 'e' || s[i] == 'E' || s[i] == '-' || s[i] == '+')) ++i;
  if (start == i) return fail("unexpected character");
  std::string num = s.substr(start, i - start);
  try {
    size_t used = 0;
    double v = std::stod(num, &used);
    if (used != num.size()) return fail("bad number");
    *out = Json(v);
  } catch (...) {
    return fail("bad number");
  }
  return true;
}

}  // namespace

bool Json::parse(const std::string& text, Json* out, std::string* error) {
  Parser p(text);
  Json value;
  if (!p.parseValue(&value, 0)) {
    if (error) *error = p.err;
    return false;
  }
  p.skipWs();
  if (p.i != text.size()) {
    if (error) *error = "trailing content at position " + std::to_string(p.i);
    return false;
  }
  *out = std::move(value);
  return true;
}

// ── serializer ─────────────────────────────────────────────────────────

namespace {

void escapeInto(std::string& o, const std::string& s) {
  o.push_back('"');
  for (char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\b': o += "\\b"; break;
      case '\f': o += "\\f"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned>(c));
          o += buf;
        } else {
          o.push_back(c);
        }
    }
  }
  o.push_back('"');
}

void numberInto(std::string& o, double v) {
  if (std::isnan(v) || std::isinf(v)) {
    // Contract: the server never invents non-finite JSON. Emit null and let the client
    // render `—` like it already does for NaN cells. The matrix binary frames carry
    // real NaN bytes instead (docs/architecture/backend-protocol-v1.md).
    o += "null";
    return;
  }
  if (v == static_cast<int64_t>(v) && std::abs(v) < 9.2e15) {
    o += std::to_string(static_cast<int64_t>(v));
    return;
  }
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.17g", v);
  o += buf;
}

void dumpInto(const Json& j, std::string& o) {
  switch (j.kind()) {
    case Json::Kind::Null: o += "null"; break;
    case Json::Kind::Bool: o += j.asBool() ? "true" : "false"; break;
    case Json::Kind::Number: numberInto(o, j.asNumber()); break;
    case Json::Kind::String: escapeInto(o, j.asString()); break;
    case Json::Kind::Array: {
      o.push_back('[');
      bool first = true;
      for (const auto& item : j.items()) {
        if (!first) o.push_back(',');
        first = false;
        dumpInto(item, o);
      }
      o.push_back(']');
      break;
    }
    case Json::Kind::Object: {
      o.push_back('{');
      bool first = true;
      for (const auto& kv : j.members()) {
        if (!first) o.push_back(',');
        first = false;
        escapeInto(o, kv.first);
        o.push_back(':');
        dumpInto(kv.second, o);
      }
      o.push_back('}');
      break;
    }
  }
}

}  // namespace

std::string Json::dump() const {
  std::string o;
  dumpInto(*this, o);
  return o;
}

}  // namespace dc
