// Minimal JSON value: parse + serialize. No dependencies, enough for the protocol v1
// control plane and the xlayer fixture files. Numbers are IEEE-754 doubles; NaN and
// Infinity cannot appear in JSON, so fixtures encode them as string sentinels and the
// callers revive them (web/tests/xlayerFixtures.test.ts does the same on the TS side).
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace dc {

class Json {
 public:
  enum class Kind { Null, Bool, Number, String, Array, Object };

  Json() : kind_(Kind::Null) {}
  explicit Json(bool b) : kind_(Kind::Bool), bool_(b) {}
  explicit Json(double n) : kind_(Kind::Number), num_(n) {}
  explicit Json(int n) : kind_(Kind::Number), num_(static_cast<double>(n)) {}
  explicit Json(int64_t n) : kind_(Kind::Number), num_(static_cast<double>(n)) {}
  explicit Json(std::string s) : kind_(Kind::String), str_(std::move(s)) {}
  // Without this overload, `Json("literal")` would prefer the standard const char*→bool
  // conversion over the user-defined std::string one and silently become true. (Found by
  // smoke test: capabilities serialized as [true,true].)
  Json(const char* s) : kind_(Kind::String), str_(s) {}  // NOLINT: allow implicit for literals
  static Json array(std::vector<Json> items = {}) {
    Json j;
    j.kind_ = Kind::Array;
    j.items_ = std::move(items);
    return j;
  }
  static Json object(std::vector<std::pair<std::string, Json>> members = {}) {
    Json j;
    j.kind_ = Kind::Object;
    j.members_ = std::move(members);
    return j;
  }

  Kind kind() const { return kind_; }
  bool isNull() const { return kind_ == Kind::Null; }
  bool isNumber() const { return kind_ == Kind::Number; }
  bool isString() const { return kind_ == Kind::String; }
  bool isArray() const { return kind_ == Kind::Array; }
  bool isObject() const { return kind_ == Kind::Object; }

  bool asBool() const { return bool_; }
  double asNumber() const { return num_; }
  const std::string& asString() const { return str_; }
  const std::vector<Json>& items() const { return items_; }
  const std::vector<std::pair<std::string, Json>>& members() const { return members_; }

  // Object access: nullptr when absent / wrong shape.
  const Json* find(const std::string& key) const;
  const Json& operator[](const std::string& key) const;  // null when absent

  void set(const std::string& key, Json value);          // replace-or-append member
  void push(Json value);                                // append to array

  std::string dump() const;

  // Parse. On failure returns false and fills `error` with a position-bearing message.
  static bool parse(const std::string& text, Json* out, std::string* error);

 private:
  Kind kind_;
  bool bool_ = false;
  double num_ = 0;
  std::string str_;
  std::vector<Json> items_;
  std::vector<std::pair<std::string, Json>> members_;
};

}  // namespace dc
