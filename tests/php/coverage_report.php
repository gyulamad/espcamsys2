<?php
// coverage_report.php — merges the per-process coverage files written by
// coverage_prepend.php and checks line coverage of the dashboard's logic.
//
// Usage: php tests/php/coverage_report.php <coverage-dir> <repo-root> <min-percent>
//
// Measured: every php/cameras/lib/**/*.php (today: Logic.php), the code the
// unit tests in tests/php/ exercise. The page scripts (index.php, settings.php,
// ...) are web entry points exercised only by the end-to-end tests through a
// real web server, so they are not part of this percentage. A lib file that no
// test loads has no coverage data at all and fails the check, rather than
// silently counting as nothing.
//
// A line is covered if ANY test process executed it. Exit code: 0 if coverage
// >= min-percent, 1 if below it or there is no data, 2 on bad usage.

if ($argc !== 4 || !is_numeric($argv[3])) {
    fwrite(STDERR, "usage: coverage_report.php <coverage-dir> <repo-root> <min-percent>\n");
    exit(2);
}
[, $dir, $root, $min] = $argv;
$min = (float)$min;

$libDir = realpath($root . '/php/cameras/lib');
if ($libDir === false) {
    fwrite(STDERR, "FAIL: php/cameras/lib not found under $root\n");
    exit(1);
}

$measured = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($libDir, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if ($f->isFile() && substr($f->getFilename(), -4) === '.php') {
        $measured[] = $f->getRealPath();
    }
}
sort($measured);

// file => [line => covered(bool)]
$lines = [];
$files = glob($dir . '/*.json') ?: [];
if (!$files) {
    echo "FAIL: no coverage files in $dir — the PHP tests produced no coverage data\n";
    exit(1);
}
foreach ($files as $jf) {
    $data = json_decode((string)file_get_contents($jf), true);
    if (!is_array($data)) {
        echo "FAIL: unreadable coverage file $jf\n";
        exit(1);
    }
    foreach ($data as $file => $ls) {
        foreach ($ls as $no => $hit) {
            $lines[$file][(int)$no] = (!empty($lines[$file][(int)$no])) || $hit === 1;
        }
    }
}

function ranges(array $nums): string
{
    $out = [];
    for ($i = 0; $i < count($nums); $i++) {
        $j = $i;
        while ($j + 1 < count($nums) && $nums[$j + 1] === $nums[$j] + 1) {
            $j++;
        }
        $out[] = $j > $i ? $nums[$i] . '-' . $nums[$j] : (string)$nums[$i];
        $i = $j;
    }
    return implode(', ', $out);
}

$name = 'Dashboard PHP logic (php/cameras/lib)';
echo "$name — line coverage (union of all PHP test processes):\n";
$total = $covered = 0;
$missingData = false;
foreach ($measured as $file) {
    $rel = ltrim(substr($file, strlen(realpath($root))), '/\\');
    if (empty($lines[$file])) {
        printf("  %-52s NO DATA (no test loads this file?)\n", $rel);
        $missingData = true;
        continue;
    }
    ksort($lines[$file]);
    $nums = array_keys($lines[$file]);
    $miss = array_values(array_filter($nums, function ($n) use ($lines, $file) { return !$lines[$file][$n]; }));
    $cov = count($nums) - count($miss);
    $total += count($nums);
    $covered += $cov;
    printf("  %-52s %5.1f%%  (%d/%d)\n", $rel, 100 * $cov / count($nums), $cov, count($nums));
    if ($miss) {
        echo '      uncovered lines: ' . ranges($miss) . "\n";
    }
}
$pct = $total ? 100 * $covered / $total : 0.0;
printf("  %-52s %5.1f%%  (%d/%d)\n", 'TOTAL', $pct, $covered, $total);

if ($missingData || $total === 0) {
    echo "FAIL: $name has a measured file with no coverage data\n";
    exit(1);
}
if ($pct < $min) {
    printf("FAIL: %s coverage %.1f%% is below the required %s%%\n", $name, $pct, rtrim(rtrim(number_format($min, 2, '.', ''), '0'), '.'));
    exit(1);
}
printf("ok: %s coverage %.1f%% >= required %s%%\n", $name, $pct, rtrim(rtrim(number_format($min, 2, '.', ''), '0'), '.'));
exit(0);
