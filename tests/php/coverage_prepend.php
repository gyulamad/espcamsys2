<?php
// coverage_prepend.php — switches line-coverage collection on for one PHP test
// process. run_tests.sh --coverage N passes it to every tests/php/test_*.php as
// `php -d auto_prepend_file=...`, so the tests themselves need no changes.
//
// At the end of the process (shutdown functions still run after the tests'
// `exit(...)`) it writes the lines of php/cameras/lib/*.php that ran to
//   $CAMTEST_COVERAGE_DIR/<pid>-<n>.json   as { "/abs/file.php": { "12": 1, "13": 0, ... } }
// 1 = executed, 0 = executable but never executed. tests/php/coverage_report.php
// merges these files across test processes and applies the minimum percentage.
//
// Works with either coverage driver: PCOV (preferred, fast) or Xdebug in
// coverage mode. Without CAMTEST_COVERAGE_DIR this file does nothing.

(function () {
    $outDir = getenv('CAMTEST_COVERAGE_DIR');
    $libDir = getenv('CAMTEST_COVERAGE_LIB');
    if ($outDir === false || $outDir === '' || $libDir === false || $libDir === '') {
        return;
    }
    $libDir = rtrim(realpath($libDir) ?: $libDir, '/\\') . DIRECTORY_SEPARATOR;

    $driver = null;
    if (function_exists('pcov\\start')) {
        $driver = 'pcov';
        \pcov\start();
    } elseif (function_exists('xdebug_start_code_coverage')) {
        $driver = 'xdebug';
        // UNUSED: also report executable lines that never ran; DEAD_CODE would
        // flag unreachable lines, which are not worth counting against anyone.
        xdebug_start_code_coverage(XDEBUG_CC_UNUSED);
    } else {
        fwrite(STDERR, "coverage_prepend: neither pcov nor xdebug is active in this php\n");
        return;
    }

    register_shutdown_function(function () use ($driver, $outDir, $libDir) {
        if ($driver === 'pcov') {
            \pcov\stop();
            $raw = \pcov\collect(\pcov\all);
        } else {
            $raw = xdebug_get_code_coverage();
            xdebug_stop_code_coverage(false);
        }

        $result = [];
        foreach ($raw as $file => $lines) {
            $real = realpath($file);
            if ($real === false || strpos($real, $libDir) !== 0) {
                continue; // test code, framework.php, anything outside lib/
            }
            $src = null;
            foreach ($lines as $no => $v) {
                if ($v > 0) {
                    $result[$real][$no] = 1;
                } elseif ($v === -1) {
                    // Xdebug (unlike PCOV) lists a function's closing `}` as an
                    // executable line — its implicit "return null" — that never
                    // runs when every path ends in an explicit `return`/`throw`.
                    // Not real code; skip it so both drivers give the same
                    // percentage.
                    if ($src === null) {
                        $src = file($real, FILE_IGNORE_NEW_LINES) ?: [];
                    }
                    $text = isset($src[$no - 1]) ? trim($src[$no - 1]) : '';
                    if ($text === '}' || $text === '};') {
                        continue;
                    }
                    $result[$real][$no] = 0;
                } // anything else (Xdebug's -2 = dead code) is not counted
            }
        }
        static $n = 0;
        $name = $outDir . '/' . getmypid() . '-' . (++$n) . '.json';
        file_put_contents($name, json_encode($result));
    });
})();
