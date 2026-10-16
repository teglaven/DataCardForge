// Tiny blocking HTTP/1.1 server on raw POSIX sockets — no third-party deps (the B-plan
// keeps the backend build to g++ + Eigen + std). One thread per connection; fine for a
// local single-user tool. Protocol: docs/architecture/backend-protocol-v1.md.
#pragma once

#include <functional>
#include <map>
#include <string>

#include "json.h"
#include "matrix_store.h"
#include "nodes.h"

namespace dc {

struct HttpRequest {
  std::string method;
  std::string path;                       // without query
  std::map<std::string, std::string> query;
  std::string body;                       // already fully read
};

struct HttpResponse {
  int status = 200;
  std::string contentType = "application/json";
  std::string body;
  // When set, body is ignored and this binary frame is written after headers.
  const std::string* binary = nullptr;
};

class HttpServer {
 public:
  using Handler = std::function<HttpResponse(const HttpRequest&)>;

  HttpServer(int port, MatrixStore* store, NodeRegistry* nodes, EventBus* bus)
      : port_(port), store_(store), nodes_(nodes), bus_(bus) {}

  // Blocks forever. Returns false with an error string logged if bind fails.
  bool serve();

 private:
  HttpResponse route(const HttpRequest& req);
  void handleConnection(int fd);

  int port_;
  MatrixStore* store_;
  NodeRegistry* nodes_;
  EventBus* bus_;
};

// Encode one matrix window as a DCM1 binary frame (see backend-protocol-v1.md).
std::string encodeMatrixFrame(const std::vector<std::vector<double>>& columns,
                              const std::vector<std::string>& names, size_t rows);

}  // namespace dc
