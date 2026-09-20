// framework.h — a minimal, dependency-free unit test "framework" for the
// C++ logic extracted from the Arduino sketch. No Catch2/GoogleTest/etc —
// just a couple of macros and a pass/fail tally, so the test binary can be
// compiled with a plain `g++` and run directly (or under gdb, to get a
// backtrace for free if something crashes).
//
// Usage:
//   #include "framework.h"
//   TEST(some_behaviour) {
//     TEST_ASSERT_EQ(add(1, 2), 3);
//   }
//   int main() {
//     RUN_TEST(some_behaviour);
//     return test::summarize();
//   }

#pragma once

#include <iostream>
#include <sstream>
#include <string>

namespace test {

inline int &passCount() { static int c = 0; return c; }
inline int &failCount() { static int c = 0; return c; }

inline void reportPass(const std::string &name) {
    passCount()++;
    std::cout << "[PASS] " << name << "\n";
}

inline void reportFail(const std::string &name, const std::string &detail) {
    failCount()++;
    std::cerr << "[FAIL] " << name << " -- " << detail << "\n";
}

// Prints the pass/fail tally and returns a process exit code: 0 if every
// assertion passed, 1 if any failed.
inline int summarize() {
    std::cout << "\n" << passCount() << " passed, " << failCount() << " failed\n";
    return failCount() == 0 ? 0 : 1;
}

} // namespace test

// Declares a test case as an ordinary function taking no arguments.
#define TEST(name) static void test_##name()

// Runs a test case declared with TEST(name). Assertion failures inside it
// are recorded but do not stop the rest of the suite from running.
#define RUN_TEST(name) test_##name()

// Fails the current test unless `cond` is true.
#define TEST_ASSERT(cond, name) \
    do { \
        if (cond) test::reportPass(name); \
        else test::reportFail(name, #cond); \
    } while (0)

// Fails the current test unless `actual == expected`, printing both values
// (via operator<<) on failure.
#define TEST_ASSERT_EQ(actual, expected, name) \
    do { \
        auto _actual = (actual); \
        auto _expected = (expected); \
        if (_actual == _expected) { \
            test::reportPass(name); \
        } else { \
            std::ostringstream _s; \
            _s << "expected [" << _expected << "] got [" << _actual << "]"; \
            test::reportFail(name, _s.str()); \
        } \
    } while (0)
