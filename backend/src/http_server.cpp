#include "http_server.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <thread>

#include "expression.h"

namespace dc {

namespace {

std::string urlDecode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '+') out.push_back(' ');
    else if (s[i] == '%' && i + 2 < s.size()) {
      out.push_back(static_cast<char>(std::stoi(s.substr(i + 1, 2), nullptr, 16)));
      i += 2;
    } else out.push_back(s[i]);
  }
  return out;
}

HttpResponse jsonError(int status, const std::string& code, Json params = Json::object()) {
  Json body = Json::object({{"code", Json(code)}});
  if (!params.isNull() && params.isObject() && !params.members().empty())
    body.set("params", std::move(params));
  return HttpResponse{status, "application/json", body.dump(), nullptr};
}

HttpResponse jsonOk(Json value) { return HttpResponse{200, "application/json", value.dump(), nullptr}; }

bool readRequest(int fd, HttpRequest* req) {
  std::string buf;
  char tmp[8192];
  size_t headerEnd = std::string::npos;
  while (headerEnd == std::string::npos) {
    ssize_t n = recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return false;
    buf.append(tmp, static_cast<size_t>(n));
    headerEnd = buf.find("\r\n\r\n");
    if (buf.size() > 32u * 1024u * 1024u) return false;  // 32 MB cap on control bodies
  }
  std::string head = buf.substr(0, headerEnd);
  size_t contentLength = 0;
  bool chunked = false;
  {
    std::string lower;
    std::transform(head.begin(), head.end(), std::back_inserter(lower),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    size_t p = lower.find("content-length:");
    if (p != std::string::npos) contentLength = std::stoul(head.substr(p + 15));
    chunked = lower.find("transfer-encoding: chunked") != std::string::npos;
  }
  std::string body = buf.substr(headerEnd + 4);
  if (chunked) {
    // Decode chunk framing.
    std::string decoded;
    size_t i = 0;
    while (true) {
      size_t eol = body.find("\r\n", i);
      while (eol == std::string::npos) {
        ssize_t n = recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) return false;
        body.append(tmp, static_cast<size_t>(n));
        eol = body.find("\r\n", i);
      }
      size_t size = std::stoul(body.substr(i, eol - i), nullptr, 16);
      if (size == 0) break;
      while (body.size() < eol + 2 + size + 2) {
        ssize_t n = recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) return false;
        body.append(tmp, static_cast<size_t>(n));
      }
      decoded.append(body, eol + 2, size);
      i = eol + 2 + size + 2;
    }
    body = decoded;
  } else {
    while (body.size() < contentLength) {
      ssize_t n = recv(fd, tmp, sizeof tmp, 0);
      if (n <= 0) return false;
      body.append(tmp, static_cast<size_t>(n));
    }
    body.resize(contentLength);
  }

  size_t sp1 = head.find(' ');
  size_t sp2 = head.find(' ', sp1 + 1);
  if (sp1 == std::string::npos || sp2 == std::string::npos) return false;
  req->method = head.substr(0, sp1);
  std::string target = head.substr(sp1 + 1, sp2 - sp1 - 1);
  size_t q = target.find('?');
  if (q == std::string::npos) {
    req->path = urlDecode(target);
  } else {
    req->path = urlDecode(target.substr(0, q));
    std::string query = target.substr(q + 1);
    size_t start = 0;
    while (start <= query.size()) {
      size_t amp = query.find('&', start);
      std::string pair = query.substr(start, amp == std::string::npos ? std::string::npos : amp - start);
      size_t eq = pair.find('=');
      if (eq != std::string::npos) req->query[urlDecode(pair.substr(0, eq))] = urlDecode(pair.substr(eq + 1));
      if (amp == std::string::npos) break;
      start = amp + 1;
    }
  }
  req->body = std::move(body);
  return true;
}

void writeAll(int fd, const char* data, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    ssize_t n = send(fd, data + sent, len - sent, MSG_NOSIGNAL);
    if (n <= 0) return;
    sent += static_cast<size_t>(n);
  }
}

long parseId(const std::string& s) {
  try {
    return std::stol(s);
  } catch (...) {
    return -1;
  }
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
        if (v.isNumber()) col.data.push_back(v.asNumber());
        else if (v.isString()) {
          const std::string& s = v.asString();
          if (s == "NaN") col.data.push_back(NAN);
          else if (s == "Infinity") col.data.push_back(INFINITY);
          else if (s == "-Infinity") col.data.push_back(-INFINITY);
          else return jsonError(400, "unexpectedToken", Json::object({{"detail", Json("bad sentinel " + s)}}));
        } else return jsonError(400, "unexpectedToken");
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

  // GET /api/matrices/{id}/window?start=&count=  → binary DCM1 frame
  if (req.path.rfind("/api/matrices/", 0) == 0 && req.method == "GET") {
    std::string rest = req.path.substr(sizeof("/api/matrices/") - 1);
    size_t slash = rest.find('/');
    long id = parseId(rest.substr(0, slash));
    if (slash == std::string::npos || rest.substr(slash) != "/window")
      return jsonError(404, "notImplemented");
    const Matrix* m = store_->get(id);
    if (!m) return jsonError(404, "unknownMatrix", Json::object({{"matrixId", Json(id)}}));
    long start = qint("start", 0);
    long count = qint("count", 500);
    count = std::min<long>(count, 5000);
    std::vector<std::vector<double>> window;
    size_t rows = store_->window(id, static_cast<size_t>(std::max(0L, start)),
                                 static_cast<size_t>(std::max(0L, count)), &window);
    std::vector<std::string> names;
    for (const auto& col : m->columns()) names.push_back(Matrix::label(col));
    HttpResponse res;
    res.status = 200;
    res.contentType = "application/octet-stream";
    res.binary = new std::string(encodeMatrixFrame(window, names, rows));
    return res;
  }

  if (req.path == "/api/nodes" && req.method == "POST") {
    Json parsed;
    std::string err;
    if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
    std::vector<PortBinding> inputs;
    for (const auto& ij : parsed["inputs"].items()) {
      PortBinding b;
      b.varName = ij["varName"].isString() ? ij["varName"].asString() : "";
      b.mode = ij["mode"].isString() ? ij["mode"].asString() : "cell";
      if (ij["sourceNodeId"].isNumber()) b.sourceNodeId = static_cast<int64_t>(ij["sourceNodeId"].asNumber());
      if (ij["sourceMatrixId"].isNumber()) b.sourceMatrixId = static_cast<int64_t>(ij["sourceMatrixId"].asNumber());
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
    const ComputeNode* node = nodes_->get(result.nodeId);
    return jsonOk(Json::object({{"nodeId", Json(result.nodeId)},
                                {"resultMatrixId", Json(node ? node->resultMatrixId : -1)},
                                {"state", Json(std::string(node ? nodeName(node->state) : "dirty"))}}));
  }

  if (req.path.rfind("/api/nodes/", 0) == 0) {
    std::string rest = req.path.substr(sizeof("/api/nodes/") - 1);
    long id = parseId(rest);
    if (id < 0) return jsonError(400, "unexpectedToken");
    const ComputeNode* existing = nodes_->get(id);
    if (!existing) return jsonError(404, "unknownNode", Json::object({{"nodeId", Json(id)}}));

    if (rest == std::to_string(id) && req.method == "PATCH") {
      Json parsed;
      std::string err;
      if (!Json::parse(req.body, &parsed, &err)) return jsonError(400, "unexpectedToken", Json::object({{"detail", Json(err)}}));
      std::vector<PortBinding> inputs;
      bool haveInputs = parsed["inputs"].isArray();
      if (haveInputs) {
        for (const auto& ij : parsed["inputs"].items()) {
          PortBinding b;
          b.varName = ij["varName"].isString() ? ij["varName"].asString() : "";
          b.mode = ij["mode"].isString() ? ij["mode"].asString() : "cell";
          if (ij["sourceNodeId"].isNumber()) b.sourceNodeId = static_cast<int64_t>(ij["sourceNodeId"].asNumber());
          if (ij["sourceMatrixId"].isNumber()) b.sourceMatrixId = static_cast<int64_t>(ij["sourceMatrixId"].asNumber());
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
      const ComputeNode* node = nodes_->get(id);
      return jsonOk(Json::object({{"nodeId", Json(id)},
                                  {"state", Json(std::string(node ? nodeName(node->state) : "dirty"))}}));
    }

    if (rest == std::to_string(id) && req.method == "DELETE") {
      bool hadDependents = false;
      if (!nodes_->remove(id, &hadDependents)) {
        return jsonError(hadDependents ? 409 : 404, hadDependents ? "hasDependents" : "unknownNode");
      }
      return jsonOk(Json::object({{"deleted", Json(id)}}));
    }

    if (rest == std::to_string(id) + "/cancel" && req.method == "POST") {
      // v1 evaluation is synchronous and short; cancel exists so the client contract
      // never changes when long jobs arrive (stage 6). Report not-running explicitly.
      return jsonError(409, "notImplemented", Json::object({{"detail", Json("no running job to cancel")}}));
    }

    if (rest == std::to_string(id) + "/result") {
      const ComputeNode* node = nodes_->get(id);
      const Matrix* m = store_->get(node->resultMatrixId);
      if (!m) return jsonError(404, "unknownMatrix");
      long start = qint("start", 0);
      long count = qint("count", 500);
      std::vector<std::vector<double>> window;
      size_t rows = store_->window(node->resultMatrixId, static_cast<size_t>(std::max(0L, start)),
                                   static_cast<size_t>(std::min(std::max(0L, count), 5000L)), &window);
      std::vector<std::string> names;
      for (const auto& col : m->columns()) names.push_back(Matrix::label(col));
      HttpResponse res;
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
  while (readRequest(fd, &req)) {
    HttpResponse res = route(req);
    std::string headers = "HTTP/1.1 " + std::to_string(res.status) + " " +
                          (res.status == 200 ? "OK" : "Error") + "\r\n";
    std::string payload;
    if (res.binary) {
      payload = *res.binary;
      delete res.binary;
      res.binary = nullptr;
    } else {
      payload = res.body;
    }
    headers += "Content-Type: " + res.contentType + "\r\n";
    headers += "Content-Length: " + std::to_string(payload.size()) + "\r\n";
    headers += "Connection: keep-alive\r\n";
    headers += "Access-Control-Allow-Origin: *\r\n";
    headers += "\r\n";
    writeAll(fd, headers.data(), headers.size());
    writeAll(fd, payload.data(), payload.size());
    if (req.method == "HEAD") break;
  }
  close(fd);
}

}  // namespace dc
