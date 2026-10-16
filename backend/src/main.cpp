#include <cstdio>
#include <cstdlib>
#include <string>

#include "http_server.h"
#include "matrix_store.h"
#include "nodes.h"

int main(int argc, char** argv) {
  int port = 37811;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
  }
  dc::MatrixStore store;
  dc::EventBus bus;
  dc::NodeRegistry nodes(&store, &bus);
  dc::HttpServer server(port, &store, &nodes, &bus);
  std::printf("dc_backend protocol=1 build=%s listening on http://127.0.0.1:%d\n", DC_GIT_SHA, port);
  std::fflush(stdout);
  if (!server.serve()) {
    std::fprintf(stderr, "failed to bind 127.0.0.1:%d\n", port);
    return 1;
  }
  return 0;
}
