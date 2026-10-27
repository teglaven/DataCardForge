#include "http_server.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstring>
#include <string_view>
#include <thread>

#include "expression.h"

namespace dc {

namespace {

// Hard bounds for one request. Headers are tiny; bodies are bounded so a client cannot
// make the server allocate without limit (audit: the old code only capped the buffer
// while it was still looking for the end of the headers).
constexpr size_t kMaxHeaderBytes = 128u * 1024u;
constexpr size_t kMaxBodyBytes = 32u * 1024u * 1024u;

std::string urlDecode(const std::string& s) {
  auto hexDigit = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '+') {
      out.push_back(' ');
      continue;
    }
    if (s[i] == '%' && i + 2 < s.size()) {
      const int hi = hexDigit(s[i + 1]);
      const int lo = hexDigit(s[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>(hi * 16 + lo));
        i += 2;
        continue;
      }
      // Malformed escape: keep it literal instead of throwing (was a remote crash).
    }
    out.push_back(s[i]);
  }
  return out;
}

// Non-throwing integer parse (std::stoul threw std::invalid_argument/out_of_range out of
// a detached thread → std::terminate → whole process died).
bool parseUnsigned(std::string_view text, size_t* out) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r')) text.remove_suffix(1);
  if (text.empty()) return false;
  unsigned long long value = 0;
  const auto res = std::from_chars(text.data(), text.data() + text.size(), value, 10);
  if (res.ec != std::errc() || res.ptr != text.data() + text.size()) return false;
  *out = static_cast<size_t>(value);  // may legitimately exceed the cap → 413, not 400
  return true;
}

bool parseHexSize(std::string_view text, size_t* out) {
  // Chunk size may carry extensions ("1a;ext=1"); only the leading hex digits count.
  const size_t semi = text.find(';');
  if (semi != std::string_view::npos) text = text.substr(0, semi);
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t')) text.remove_prefix(1);
  while (!text.empty() && (text.back() == ' ' || text.back() == '\t')) text.remove_suffix(1);
  if (text.empty()) return false;
  unsigned long long value = 0;
  const auto res = std::from_chars(text.data(), text.data() + text.size(), value, 16);
  if (res.ec != std::errc() || res.ptr != text.data() + text.size()) return false;
  *out = static_cast<size_t>(value);
  return true;
}

long parseId(const std::string& s) {
  long long value = 0;
  const auto res = std::from_chars(s.data(), s.data() + s.size(), value, 10);
  if (res.ec != std::errc() || res.ptr != s.data() + s.size()) return -1;
  return static_cast<long>(value);
}

HttpResponse jsonError(int status, const std::string& code, Json params = Json::object()) {
  Json body = Json::object({{"code", Json(code)}});
  if (!params.isNull() && params.isObject() && !params.members().empty())
    body.set("params", std::move(params));
  return HttpResponse{status, "application/json", body.dump(), nullptr};
}

HttpResponse jsonOk(Json value) { return HttpResponse{200, "application/json", value.dump(), nullptr}; }

enum class ReadStatus { Ok, Closed, BadRequest, TooLarge };

// Reads exactly one HTTP/1.1 request. Never throws: every numeric field goes through
// from_chars and the whole routine is additionally guarded by a catch-all, because this
// runs on a detached per-connection thread where an escaping exception kills the process.
ReadStatus readRequestImpl(int fd, HttpRequest* req) {
  std::string buf;
  char tmp[8192];
  size_t headerEnd = std::string::npos;
  while (headerEnd == std::string::npos) {
    const ssize_t n = recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return ReadStatus::Closed;
    buf.append(tmp, static_cast<size_t>(n));
    headerEnd = buf.find("\r\n\r\n");
    if (headerEnd == std::string::npos && buf.size() > kMaxHeaderBytes) return ReadStatus::BadRequest;
  }
  const std::string head = buf.substr(0, headerEnd);

  size_t contentLength = 0;
  bool haveContentLength = false;
  bool chunked = false;
  {
    std::string lower;
    lower.reserve(head.size());
    std::transform(head.begin(), head.end(), std::back_inserter(lower),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const size_t p = lower.find("\r\ncontent-length:");
    if (p != std::string::npos) {
      const std::string_view value(head.data() + p + 2 + 15, head.size() - (p + 2 + 15));
      const size_t crlf = value.find("\r\n");
      if (!parseUnsigned(value.substr(0, crlf), &contentLength)) return ReadStatus::BadRequest;
      haveContentLength = true;
    }
    if (lower.find("\r\ntransfer-encoding:") != std::string::npos &&
        lower.find("chunked") != std::string::npos)
      chunked = true;
  }

  std::string body = buf.substr(headerEnd + 4);
  if (chunked) {
    std::string decoded;
    size_t i = 0;
    for (;;) {
      size_t eol = body.find("\r\n", i);
      while (eol == std::string::npos) {
        const ssize_t n = recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) return ReadStatus::Closed;
        body.append(tmp, static_cast<size_t>(n));
        if (body.size() > kMaxBodyBytes + kMaxHeaderBytes) return ReadStatus::TooLarge;
        eol = body.find("\r\n", i);
      }
      size_t size = 0;
      if (!parseHexSize(std::string_view(body).substr(i, eol - i), &size)) return ReadStatus::BadRequest;
      if (size == 0) break;
      if (size > kMaxBodyBytes) return ReadStatus::TooLarge;
      while (body.size() < eol + 2 + size + 2) {
        const ssize_t n = recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) return ReadStatus::Closed;
        body.append(tmp, static_cast<size_t>(n));
        if (body.size() > kMaxBodyBytes + kMaxHeaderBytes) return ReadStatus::TooLarge;
      }
      if (decoded.size() + size > kMaxBodyBytes) return ReadStatus::TooLarge;
      decoded.append(body, eol + 2, size);
      i = eol + 2 + size + 2;
    }
    body = std::move(decoded);
  } else {
    if (haveContentLength && contentLength > kMaxBodyBytes) return ReadStatus::TooLarge;
    while (body.size() < contentLength) {
      const ssize_t n = recv(fd, tmp, sizeof tmp, 0);
      if (n <= 0) return ReadStatus::Closed;
      body.append(tmp, static_cast<size_t>(n));
      if (body.size() > contentLength) break;
    }
    if (body.size() < contentLength) return ReadStatus::Closed;
    body.resize(contentLength);
  }

  const size_t sp1 = head.find(' ');
  if (sp1 == std::string::npos) return ReadStatus::BadRequest;
  const size_t sp2 = head.find(' ', sp1 + 1);
  if (sp2 == std::string::npos) return ReadStatus::BadRequest;
  req->method = head.substr(0, sp1);
  const std::string target = head.substr(sp1 + 1, sp2 - sp1 - 1);
  const size_t q = target.find('?');
  if (q == std::string::npos) {
    req->path = urlDecode(target);
  } else {
    req->path = urlDecode(target.substr(0, q));
    const std::string query = target.substr(q + 1);
    size_t start = 0;
    while (start <= query.size()) {
      const size_t amp = query.find('&', start);
      const std::string pair = query.substr(start, amp == std::string::npos ? std::string::npos : amp - start);
      const size_t eq = pair.find('=');
      if (eq != std::string::npos) req->query[urlDecode(pair.substr(0, eq))] = urlDecode(pair.substr(eq + 1));
      if (amp == std::string::npos) break;
      start = amp + 1;
    }
  }
  req->body = std::move(body);
  return ReadStatus::Ok;
}

ReadStatus readRequest(int fd, HttpRequest* req) {
  try {
    return readRequestImpl(fd, req);
  } catch (...) {
    // Allocation failure or any other unexpected throw: refuse the request, keep serving.
    return ReadStatus::BadRequest;
  }
}

void writeAll(int fd, const char* data, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    const ssize_t n = send(fd, data + sent, len - sent, MSG_NOSIGNAL);
    if (n <= 0) return;
    sent += static_cast<size_t>(n);
  }
}

void sendResponse(int fd, HttpResponse& res, bool headersOnly) {
  std::string payload;
  if (res.binary) {
    payload = *res.binary;
    delete res.binary;
    res.binary = nullptr;
  } else {
    payload = res.body;
  }
  std::string headers = "HTTP/1.1 " + std::to_string(res.status) + " " +
                        (res.status == 200 ? "OK" : "Error") + "\r\n";
  headers += "Content-Type: " + res.contentType + "\r\n";
  headers += "Content-Length: " + std::to_string(payload.size()) + "\r\n";
  headers += "Connection: keep-alive\r\n";
  headers += "Access-Control-Allow-Origin: *\r\n";
  headers += "\r\n";
  writeAll(fd, headers.data(), headers.size());
  if (!headersOnly) writeAll(fd, payload.data(), payload.size());
}

uint32_t readU32LE(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

double readF64LE(const unsigned char* p) {
  uint64_t bits = 0;
  for (int i = 7; i >= 0; --i) bits = (bits << 8) | p[i];
  double value = 0;
  std::memcpy(&value, &bits, sizeof value);
  return value;
}

// Decode a DCM1 frame body into columns (POST /api/matrices/raw).
bool decodeMatrixFrame(const std::string& frame, std::vector<Column>* columns, std::string* err) {
  if (frame.size() < 16) {
    *err = "frame shorter than the 16-byte header";
    return false;
  }
  const auto* bytes = reinterpret_cast<const unsigned char*>(frame.data());
  if (readU32LE(bytes) != 0x44434D31u) {
    *err = "bad magic (expected DCM1)";
    return false;
  }
  const uint32_t rows = readU32LE(bytes + 4);
  const uint32_t cols = readU32LE(bytes + 8);
  const uint32_t namesLen = readU32LE(bytes + 12);
  // Bound the shape BEFORE multiplying: rows*cols*8 can wrap uint64 for hostile headers,
  // which would make the truncation check pass and the copy run off the buffer.
  if (cols > kMaxBodyBytes / 8u || namesLen > kMaxBodyBytes ||
      (rows > 0 && cols > kMaxBodyBytes / 8u / rows)) {
    *err = "frame shape too large";
    return false;
  }
  const uint64_t dataLen = static_cast<uint64_t>(rows) * cols * 8u;
  const uint64_t needed = 16ull + dataLen + namesLen;
  if (frame.size() < needed) {
    *err = "truncated frame";
    return false;
  }
  Json names;
  if (namesLen > 0) {
    std::string namesJson(frame.data() + 16 + dataLen, namesLen);
    std::string jerr;
    if (!Json::parse(namesJson, &names, &jerr) || !names.isArray()) {
      *err = "bad names payload: " + jerr;
      return false;
    }
  }
  columns->clear();
  columns->reserve(cols);
  for (uint32_t c = 0; c < cols; ++c) {
    Column col;
    if (names.isArray() && c < names.items().size() && names.items()[c].isString())
      Matrix::labelParsed(names.items()[c].asString(), &col.posName, &col.annotation);
    else
      col.posName = "Pos." + std::to_string(c + 1);
    col.data.resize(rows);
    const unsigned char* base = bytes + 16 + static_cast<size_t>(c) * rows * 8u;
    for (uint32_t r = 0; r < rows; ++r) col.data[r] = readF64LE(base + static_cast<size_t>(r) * 8u);
    columns->push_back(std::move(col));
  }
  return true;
}

double cellValue(const Json& v, bool* ok) {
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

// /api/matrices/{id}[/suffix] → id + "/suffix" ("" when absent).
bool splitMatrixPath(const std::string& path, long* id, std::string* suffix) {
  static const std::string prefix = "/api/matrices/";
  if (path.rfind(prefix, 0) != 0) return false;
  const std::string rest = path.substr(prefix.size());
  const size_t slash = rest.find('/');
  *id = parseId(rest.substr(0, slash));
  *suffix = slash == std::string::npos ? std::string() : rest.substr(slash);
  return true;
}

}  // namespace

std::string encodeMatrixFrame(const std::vector<std::vector<double>>& columns,
                              const std::vector<std::string>& names, size_t rows) {
  Json nameArr = Json::array();
  for (const auto& n : names) nameArr.push(Json(n));
  std::string namesJson = nameArr.dump();
  uint32_t magic = 0x44434D31;
  uint32_t cols = static_cast<uint32_t>(columns.size());
  uint32_t rowsU = static_cast<uint32_t>(rows);
  uint32_t namesLen = static_cast<uint32_t>(namesJson.size());
  std::string out;
  out.reserve(16 + cols * rows * 8 + namesLen);
  out.append(reinterpret_cast<char*>(&magic), 4);
  out.append(reinterpret_cast<char*>(&rowsU), 4);
  out.append(reinterpret_cast<char*>(&cols), 4);
  out.append(reinterpret_cast<char*>(&namesLen), 4);
  for (const auto& col : columns) {
    std::vector<double> padded = col;
    padded.resize(rows, NAN);
    out.append(reinterpret_cast<const char*>(padded.data()), rows * 8);
  }
  out.append(namesJson);
  return out;
}

// ── routing ────────────────────────────────────────────────────────────

HttpResponse HttpServer::route(const HttpRequest& req) {
  auto qint = [&](const char* key, long fallback) {
    auto it = req.query.find(key);
    return it == req.query.end() ? fallback : parseId(it->second);
  };

  if (req.path == "/api/hello") {
    Json caps = Json::array();
    caps.push(Json("expr.v1"));
    caps.push(Json("matrix.v1"));
    Json limits = Json::object({{"maxWindowRows", Json(5000)}});
    return jsonOk(Json::object({{"protocol", Json(1)},
                                {"build", Json(std::string(DC_GIT_SHA))},
                                {"capabilities", std::move(caps)},
                                {"limits", std::move(limits)}}));
  }

  if (req.path == "/api/matrices" && req.method == "POST") {
    Json parsed;
    std::string err;
    if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
    const Json& colsJson = parsed["columns"];
    if (!colsJson.isArray()) return jsonError(400, "unexpectedToken");
    std::vector<Column> columns;
    size_t rows = 0;
    for (const auto& cj : colsJson.items()) {
      Column col;
      col.posName = cj["posName"].isString() ? cj["posName"].asString()
                                             : "Pos." + std::to_string(columns.size() + 1);
      col.annotation = cj["annotation"].isString() ? cj["annotation"].asString() : "";
      const Json& data = cj["data"];
      if (!data.isArray()) return jsonError(400, "unexpectedToken");
      for (const auto& v : data.items()) {
        bool ok = false;
        const double value = cellValue(v, &ok);
        if (!ok) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json("bad cell value")}}));
        col.data.push_back(value);
      }
      if (columns.empty()) rows = col.data.size();
      else if (col.data.size() != rows) return jsonError(400, "shapeMismatch");
      columns.push_back(std::move(col));
    }
    Matrix m(std::move(columns));
    if (parsed["name"].isString()) m.name = parsed["name"].asString();
    int64_t id = store_->insert(std::move(m));
    bus_->publish(Json::object({{"matrixId", Json(id)}, {"state", Json(std::string("done"))}}));
    nodes_->onMatrixChanged(id);
    return jsonOk(Json::object({{"matrixId", Json(id)}, {"revision", Json(1)}}));
  }

  // POST /api/matrices/raw — a DCM1 frame body (protocol v1 "载荷编码"), avoids the JSON
  // overhead of the text endpoint for uploads parsed in the browser.
  if (req.path == "/api/matrices/raw" && req.method == "POST") {
    std::vector<Column> columns;
    std::string err;
    if (!decodeMatrixFrame(req.body, &columns, &err))
      return jsonError(400, "badFrame", Json::object({{"detail", Json(err)}}));
    size_t rows = 0;
    for (const auto& c : columns) {
      if (c.data.size() > rows) rows = c.data.size();
    }
    for (auto& c : columns) c.data.resize(rows, NAN);
    Matrix m(std::move(columns));
    m.name = "raw";
    int64_t id = store_->insert(std::move(m));
    bus_->publish(Json::object({{"matrixId", Json(id)}, {"state", Json(std::string("done"))}}));
    nodes_->onMatrixChanged(id);
    return jsonOk(Json::object({{"matrixId", Json(id)}, {"revision", Json(1)}}));
  }

  long matrixId = -1;
  std::string matrixSuffix;
  const bool isMatrixPath = splitMatrixPath(req.path, &matrixId, &matrixSuffix);

  // GET /api/matrices/{id}/window?start=&count=  → binary DCM1 frame
  if (isMatrixPath && req.method == "GET" && matrixSuffix == "/window") {
    std::vector<std::string> names;
    if (!store_->labels(matrixId, &names))
      return jsonError(404, "unknownMatrix", Json::object({{"matrixId", Json(matrixId)}}));
    const long start = qint("start", 0);
    long count = qint("count", 500);
    count = std::min<long>(std::max(0L, count), 5000);
    std::vector<std::vector<double>> window;
    const size_t rows = store_->window(matrixId, static_cast<size_t>(std::max(0L, start)),
                                       static_cast<size_t>(count), &window);
    HttpResponse res;
    res.status = 200;
    res.contentType = "application/octet-stream";
    res.binary = new std::string(encodeMatrixFrame(window, names, rows));
    return res;
  }

  // PATCH /api/matrices/{id} {cells:[{row,col,value}]} — browser cell edits.
  if (isMatrixPath && req.method == "PATCH" && matrixSuffix.empty()) {
    if (matrixId < 0) return jsonError(400, "unexpectedToken");
    Json parsed;
    std::string err;
    if (!Json::parse(req.body, &parsed, &err))
      return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
    const Json& cells = parsed["cells"];
    if (!cells.isArray()) return jsonError(400, "unexpectedToken");
    std::vector<CellPatch> patches;
    patches.reserve(cells.items().size());
    for (const auto& cj : cells.items()) {
      if (!cj["row"].isNumber() || !cj["col"].isNumber()) return jsonError(400, "unexpectedToken");
      const double row = cj["row"].asNumber();
      const double col = cj["col"].asNumber();
      if (row < 0 || col < 0) return jsonError(400, "shapeMismatch");
      bool ok = false;
      const double value = cellValue(cj["value"], &ok);
      if (!ok) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json("bad cell value")}}));
      CellPatch patch;
      patch.row = static_cast<size_t>(row);
      patch.col = static_cast<size_t>(col);
      patch.value = value;
      patches.push_back(patch);
    }
    int64_t revision = 0;
    if (!store_->patchCells(matrixId, patches, &revision)) {
      Matrix probe;
      if (!store_->snapshot(matrixId, &probe))
        return jsonError(404, "unknownMatrix", Json::object({{"matrixId", Json(matrixId)}}));
      return jsonError(400, "shapeMismatch");
    }
    bus_->publish(Json::object({{"matrixId", Json(matrixId)}, {"revision", Json(revision)}}));
    return jsonOk(Json::object({{"matrixId", Json(matrixId)}, {"revision", Json(revision)}}));
  }

  // DELETE /api/matrices/{id} — refused while a compute node still reads or owns it.
  if (isMatrixPath && req.method == "DELETE" && matrixSuffix.empty()) {
    bool hadDependents = false;
    if (!nodes_->removeMatrix(matrixId, &hadDependents)) {
      return jsonError(hadDependents ? 409 : 404,
                       hadDependents ? "hasDependents" : "unknownMatrix",
                       Json::object({{"matrixId", Json(matrixId)}}));
    }
    bus_->publish(Json::object({{"matrixId", Json(matrixId)}, {"deleted", Json(true)}}));
    return jsonOk(Json::object({{"deleted", Json(matrixId)}}));
  }

  // GET /api/nodes — the ids of every live compute node. Lets a client reconcile a
  // restored workspace against the server's authoritative set (protocol v1, additive).
  if (req.path == "/api/nodes" && req.method == "GET") {
    Json arr = Json::array();
    for (int64_t id : nodes_->allNodeIds()) arr.push(Json(id));
    return jsonOk(Json::object({{"nodes", std::move(arr)}}));
  }

  if (req.path == "/api/nodes" && req.method == "POST") {
    Json parsed;
    std::string err;
    if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
    std::vector<PortBinding> inputs;
    for (const auto& ij : parsed["inputs"].items()) {
      PortBinding b;
      b.portId = ij["portId"].isString() ? ij["portId"].asString() : "";
      b.varName = ij["varName"].isString() ? ij["varName"].asString() : "";
      b.mode = ij["mode"].isString() ? ij["mode"].asString() : "cell";
      if (ij["sourceNodeId"].isNumber()) b.sourceNodeId = static_cast<int64_t>(ij["sourceNodeId"].asNumber());
      if (ij["sourceMatrixId"].isNumber()) b.sourceMatrixId = static_cast<int64_t>(ij["sourceMatrixId"].asNumber());
      if (ij["sourceOutputIndex"].isNumber()) b.sourceOutputIndex = static_cast<int32_t>(ij["sourceOutputIndex"].asNumber());
      inputs.push_back(std::move(b));
    }
    std::string formula = parsed["formula"].isString() ? parsed["formula"].asString() : "";
    auto result = nodes_->create(inputs, formula);
    if (!result.cyclePath.empty()) {
      Json path = Json::array();
      for (auto p : result.cyclePath) path.push(Json(p));
      return jsonError(409, "cycle", Json::object({{"path", std::move(path)}}));
    }
    if (result.nodeId < 0) return jsonError(400, "unexpectedToken");
    nodes_->recomputeSubtree(result.nodeId);
    const auto node = nodes_->get(result.nodeId);
    Json out = Json::object({{"nodeId", Json(result.nodeId)},
                             {"resultMatrixId", Json(node ? node->resultMatrixId() : int64_t{-1})},
                             {"state", Json(std::string(node ? nodeName(node->state) : "dirty"))}});
    if (node) {
      Json ids = Json::array();
      for (int64_t id : node->resultMatrixIds) ids.push(Json(id));
      out.set("resultMatrixIds", std::move(ids));
    }
    return jsonOk(std::move(out));
  }

  if (req.path.rfind("/api/nodes/", 0) == 0) {
    const std::string rest = req.path.substr(sizeof("/api/nodes/") - 1);
    const size_t slash = rest.find('/');
    const long id = parseId(rest.substr(0, slash));
    const std::string suffix = slash == std::string::npos ? std::string() : rest.substr(slash);
    if (id < 0) return jsonError(400, "unexpectedToken");
    const auto existing = nodes_->get(id);
    if (!existing) return jsonError(404, "unknownNode", Json::object({{"nodeId", Json(id)}}));

    // GET /api/nodes/{id} — the node's authoritative status snapshot. The event stream is
    // transient (bounded log), so a client that reconnects or restores a workspace needs
    // to re-read state without replaying it (protocol v1, additive).
    if (suffix.empty() && req.method == "GET") {
      Json out = Json::object({{"nodeId", Json(existing->id)},
                               {"state", Json(std::string(nodeName(existing->state)))},
                               {"resultMatrixId", Json(existing->resultMatrixId())}});
      if (existing->state == NodeState::Error) {
        out.set("code", Json(existing->errorCode));
        out.set("params", existing->errorParams);
      }
      return jsonOk(std::move(out));
    }

    if (suffix.empty() && req.method == "PATCH") {
      Json parsed;
      std::string err;
      if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
      std::vector<PortBinding> inputs;
      bool haveInputs = parsed["inputs"].isArray();
      if (haveInputs) {
        for (const auto& ij : parsed["inputs"].items()) {
          PortBinding b;
          b.portId = ij["portId"].isString() ? ij["portId"].asString() : "";
          b.varName = ij["varName"].isString() ? ij["varName"].asString() : "";
          b.mode = ij["mode"].isString() ? ij["mode"].asString() : "cell";
          if (ij["sourceNodeId"].isNumber()) b.sourceNodeId = static_cast<int64_t>(ij["sourceNodeId"].asNumber());
          if (ij["sourceMatrixId"].isNumber()) b.sourceMatrixId = static_cast<int64_t>(ij["sourceMatrixId"].asNumber());
          if (ij["sourceOutputIndex"].isNumber()) b.sourceOutputIndex = static_cast<int32_t>(ij["sourceOutputIndex"].asNumber());
          inputs.push_back(std::move(b));
        }
      }
      const std::string* formula = parsed["formula"].isString() ? &parsed["formula"].asString() : nullptr;
      std::vector<int64_t> cycleOut;
      if (!nodes_->update(id, formula, haveInputs ? &inputs : nullptr, &cycleOut)) {
        if (!cycleOut.empty()) {
          Json path = Json::array();
          for (auto p : cycleOut) path.push(Json(p));
          return jsonError(409, "cycle", Json::object({{"path", std::move(path)}}));
        }
        return jsonError(404, "unknownNode");
      }
      nodes_->recomputeSubtree(id);
      const auto node = nodes_->get(id);
      return jsonOk(Json::object({{"nodeId", Json(id)},
                                  {"state", Json(std::string(node ? nodeName(node->state) : "dirty"))}}));
    }

    if (suffix.empty() && req.method == "DELETE") {
      bool hadDependents = false;
      if (!nodes_->remove(id, &hadDependents)) {
        return jsonError(hadDependents ? 409 : 404, hadDependents ? "hasDependents" : "unknownNode");
      }
      return jsonOk(Json::object({{"deleted", Json(id)}}));
    }

    if (suffix == "/cancel" && req.method == "POST") {
      // v1 evaluation is synchronous and short; cancel exists so the client contract
      // never changes when long jobs arrive (stage 6). Report not-running explicitly.
      return jsonError(409, "notImplemented", Json::object({{"detail", Json("no running job to cancel")}}));
    }

    if (suffix == "/result") {
      const auto node = nodes_->get(id);
      if (!node) return jsonError(404, "unknownNode", Json::object({{"nodeId", Json(id)}}));
      std::vector<std::string> names;
      if (!store_->labels(node->resultMatrixId(), &names)) return jsonError(404, "unknownMatrix");
      const long start = qint("start", 0);
      long count = qint("count", 500);
      count = std::min<long>(std::max(0L, count), 5000);
      std::vector<std::vector<double>> window;
      const size_t rows = store_->window(node->resultMatrixId(), static_cast<size_t>(std::max(0L, start)),
                                         static_cast<size_t>(count), &window);
      HttpResponse res;
      res.status = 200;
      res.contentType = "application/octet-stream";
      res.binary = new std::string(encodeMatrixFrame(window, names, rows));
      return res;
    }
  }

  if (req.path == "/api/events") {
    long since = qint("since", 0);
    long timeout = qint("timeout", 25);
    auto events = bus_->wait(since, static_cast<int>(std::min(std::max(timeout, 1L), 60L) * 1000));
    Json arr = Json::array();
    for (const auto& e : events) {
      Json ev = e.second;
      ev.set("seq", Json(e.first));
      arr.push(std::move(ev));
    }
    return jsonOk(std::move(arr));
  }

  return jsonError(404, "notImplemented");
}

// ── socket plumbing ────────────────────────────────────────────────────

bool HttpServer::serve() {
  int srv = socket(AF_INET, SOCK_STREAM, 0);
  if (srv < 0) return false;
  int one = 1;
  setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(static_cast<uint16_t>(port_));
  if (bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
    close(srv);
    return false;
  }
  if (listen(srv, 64) < 0) {
    close(srv);
    return false;
  }
  while (true) {
    int fd = accept(srv, nullptr, nullptr);
    if (fd < 0) continue;
    std::thread([this, fd] { handleConnection(fd); }).detach();
  }
}

void HttpServer::handleConnection(int fd) {
  HttpRequest req;
  for (;;) {
    const ReadStatus status = readRequest(fd, &req);
    if (status == ReadStatus::Closed) break;
    if (status == ReadStatus::BadRequest || status == ReadStatus::TooLarge) {
      // Framing is unusable; answer once and drop the connection instead of looping.
      HttpResponse res = status == ReadStatus::TooLarge ? jsonError(413, "payloadTooLarge")
                                                        : jsonError(400, "unexpectedToken");
      sendResponse(fd, res, false);
      break;
    }
    HttpResponse res;
    try {
      res = route(req);
    } catch (const std::exception&) {
      res = jsonError(500, "internalError");
    } catch (...) {
      res = jsonError(500, "internalError");
    }
    const bool headersOnly = req.method == "HEAD";
    sendResponse(fd, res, headersOnly);
    if (headersOnly) break;
  }
  close(fd);
}

}  // namespace dc
