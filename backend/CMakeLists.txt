cmake_minimum_required(VERSION 3.24)
project(dcb_backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Eigen3 3.4 REQUIRED NO_MODULE)
find_package(Threads REQUIRED)

execute_process(COMMAND git rev-parse --short HEAD WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
                OUTPUT_VARIABLE DC_SHA OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
if(NOT DC_SHA)
  set(DC_SHA "unknown")
endif()
add_compile_definitions(DC_GIT_SHA="${DC_SHA}")

add_library(dc_core
  src/json.cpp
  src/matrix_store.cpp
  src/matrix_value.cpp
  src/expression.cpp
  src/signature.cpp
  src/nodes.cpp
)
target_include_directories(dc_core PUBLIC src)
target_link_libraries(dc_core PUBLIC Eigen3::Eigen)

add_executable(dc_backend src/http_server.cpp src/main.cpp)
target_link_libraries(dc_backend PRIVATE dc_core Threads::Threads)

# Fixture runner: the same xlayer JSON that gates the TS reference (stage-0 contract).
add_executable(dc_fixture_run tests/fixture_runner.cpp)
target_link_libraries(dc_fixture_run PRIVATE dc_core)

enable_testing()
add_test(NAME xlayer_fixtures
  COMMAND dc_fixture_run ${CMAKE_SOURCE_DIR}/../web/tests/fixtures/xlayer/expression.v1.json)
add_test(NAME matrix_fixtures
  COMMAND dc_fixture_run ${CMAKE_SOURCE_DIR}/../web/tests/fixtures/xlayer/matrix.v1.json)

add_executable(dc_nodes_test tests/nodes_test.cpp)
target_link_libraries(dc_nodes_test PRIVATE dc_core)
add_test(NAME node_registry COMMAND dc_nodes_test)

# Card-layer fixtures: the SAME JSON the TypeScript side parses
# (web/tests/cardFixtures.test.ts). TS judges how a card becomes port bindings; this judges
# what those bindings compute. Together they are the referee the v2 schema decision demands.
add_executable(dc_card_fixture_run tests/card_fixture_run.cpp)
target_link_libraries(dc_card_fixture_run PRIVATE dc_core)
add_test(NAME card_fixtures
  COMMAND dc_card_fixture_run ${CMAKE_SOURCE_DIR}/../web/tests/fixtures/cards/function-card.v2.json)

# Both opt-in gates below need a Python interpreter, and find_package must run BEFORE
# the add_test calls that expand ${Python3_EXECUTABLE} — otherwise the variable is empty,
# the command degenerates to the bare script path, and ctest fails with BAD_COMMAND
# ("permission denied"). Learned the hard way while wiring the fuzz gate.
find_package(Python3 COMPONENTS Interpreter QUIET)

# Differential fuzz: random expressions evaluated by BOTH engines (C++ here, the TS
# reference via web/scripts/diff_fuzz.mjs importing src/core/expression.ts itself), with
# numeric results AND structured errors (code/position/params) compared. Fixed fixtures
# cover hand-written cases; this keeps discovering new divergences. Opt-in like http_stress:
# without DC_RUN_FUZZ=1 the gate exits 101 and ctest records "Not Run" — CI stays fast and
# deterministic. Seeds are explicit (--seed); divergences print a minimal repro.
add_executable(dc_diff_run tests/diff_run.cpp)
target_link_libraries(dc_diff_run PRIVATE dc_core)
if(Python3_Interpreter_FOUND)
  add_test(NAME diff_fuzz
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/fuzz_gate.py
            --script ${CMAKE_SOURCE_DIR}/../web/scripts/diff_fuzz.mjs
            --cpp-bin $<TARGET_FILE:dc_diff_run> --iters 2000)
  set_tests_properties(diff_fuzz PROPERTIES SKIP_RETURN_CODE 101)
endif()

# Stress gate: hammer the HTTP server with malformed requests and assert the process
# survives (the 2026-10-18 audit found std::stoul terminating the whole process from a
# detached connection thread). Opt-in via DC_RUN_STRESS=1 so CI stays fast: without it
# the script exits 101 and ctest records "Not Run" instead of a silent pass. It always
# binds a throwaway port — never 37811, where the systemd service lives.
if(Python3_Interpreter_FOUND)
  # Node-registry concurrency (2026-10-27): evaluation no longer holds the registry lock,
  # so concurrent create / params-rewrite / window-read / delete must not deadlock, crash,
  # or publish a result whose definition was replaced mid-computation. Same opt-in gate.
  add_test(NAME nodes_stress
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/stress/nodes_stress.py
            --binary $<TARGET_FILE:dc_backend> --threads 8 --rounds 25)
  set_tests_properties(nodes_stress PROPERTIES SKIP_RETURN_CODE 101)

  add_test(NAME http_stress
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/stress/stress_test.py
            --binary $<TARGET_FILE:dc_backend> --port 37911
            --rounds 2 --threads 20 --requests 5)
  set_tests_properties(http_stress PROPERTIES SKIP_RETURN_CODE 101)
endif()
