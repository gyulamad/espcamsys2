<?php
// framework.php — a minimal, dependency-free unit test "framework" for the
// PHP logic extracted from the dashboard (php/cameras/lib/Logic.php). No
// PHPUnit, no Composer — just a `camtest_test($name, $fn)` runner and a
// couple of assertion helpers, run directly with the `php` CLI.
//
// Usage:
//   require_once __DIR__ . '/framework.php';
//   camtest_test('adds numbers', function () {
//       camtest_assert_equal(1 + 2, 3);
//   });
//   exit(camtest_summarize());

$GLOBALS['__camtest_pass'] = 0;
$GLOBALS['__camtest_fail'] = 0;

function camtest_test(string $name, callable $fn): void
{
    try {
        $fn();
        $GLOBALS['__camtest_pass']++;
        echo "[PASS] $name\n";
    } catch (Throwable $e) {
        $GLOBALS['__camtest_fail']++;
        fwrite(STDERR, "[FAIL] $name -- " . $e->getMessage() . "\n");
    }
}

// Compares two values by their exported representation — good enough for
// the scalars/arrays these tests compare, and keeps this framework
// dependency-free.
function camtest_assert_equal($actual, $expected, string $msg = ''): void
{
    $a = var_export($actual, true);
    $e = var_export($expected, true);
    if ($a !== $e) {
        throw new Exception(($msg !== '' ? "$msg: " : '') . "expected $e got $a");
    }
}

function camtest_assert_true($cond, string $msg = 'expected truthy value'): void
{
    if (!$cond) {
        throw new Exception($msg);
    }
}

// Prints the pass/fail tally and returns a process exit code: 0 if every
// assertion passed, 1 if any failed.
function camtest_summarize(): int
{
    $pass = $GLOBALS['__camtest_pass'];
    $fail = $GLOBALS['__camtest_fail'];
    echo "\n$pass passed, $fail failed\n";
    return $fail === 0 ? 0 : 1;
}
