<?php
// Layout.php — the small pieces of HTML that more than one dashboard page shows, so a page does not
// copy them (and a change is made once). Only builds text; no request, no session, no output.
// Unit tested in tests/php/test_layout.php.

class CamLayout
{
    // The LOG OUT button. A real <form> POST to logout.php — not a link (a link can be triggered by
    // another website or a prefetch) and not JavaScript (so it works with scripts blocked). The
    // browser's own same-origin headers are what logout.php checks, see CamLogic::logoutRefusalStatus().
    public static function logoutForm(): string
    {
        return '<form class="logout-form" method="post" action="logout.php">'
            . '<button class="btn" type="submit" title="Log out: this browser forgets the dashboard login">⏻ LOG OUT</button>'
            . '</form>';
    }

    // The low-storage warning: asks storage.php on every page load and, when the Pi's recording disk is
    // nearly full, shows the server's message in a browser alert box — on top of everything, and closed with
    // one click, so the dashboard stays usable. Put once at the end of <body> of each page that has the
    // dashboard header. Silent in every other case (disk fine, relay down, request failed): a warning
    // that cannot be read must not become an error box. The message is shown with alert(), which
    // never interprets HTML, and only when it is text.
    public static function storageWarningScript(): string
    {
        return <<<'HTML'
<script>
  (function () {
    fetch('storage.php', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.low === true && typeof d.message === 'string' && d.message !== '') alert(d.message);
      })
      .catch(function () {});
  })();
</script>
HTML;
    }

    // A reboot / reset drop-down: a split button. The main button runs the menu's default target at
    // once (after the page's confirmation); the arrow opens a list with every target. $menu comes from
    // CamLogic::rebootMenu(); $btnClass is the page's button style ('btn' in the header, 'cam-btn' on a
    // camera card); $camId is the camera it belongs to (null = the whole system).
    //
    // No inline handlers: the buttons only carry data-target / data-confirm, and ONE listener in the
    // page (index.php) does the rest, so nothing here depends on JavaScript being allowed inline and
    // nothing from config.php (a camera id) can become script. Everything is escaped.
    public static function rebootMenu(array $menu, string $btnClass, ?string $camId = null): string
    {
        $esc = static function ($s): string {
            // &#10; keeps the line breaks of a confirmation text in an attribute for sure
            return str_replace("\n", '&#10;', htmlspecialchars((string) $s, ENT_QUOTES));
        };
        $default = $menu['default'];
        $defaultOption = $menu['options'][$default];

        $items = '';
        foreach ($menu['options'] as $target => $option) {
            $items .= '<button type="button" role="menuitem" class="reboot-item' . ($target === $default ? ' default' : '') . '"'
                . ' data-target="' . $esc($target) . '" data-confirm="' . $esc($option['confirm']) . '">'
                . $esc($option['label']) . '</button>';
        }

        return '<span class="reboot-menu"' . ($camId === null ? '' : ' data-cam="' . $esc($camId) . '"') . '>'
            . '<span class="reboot-split">'
            . '<button type="button" class="' . $esc($btnClass) . ' danger reboot-main"'
            . ' data-target="' . $esc($default) . '" data-confirm="' . $esc($defaultOption['confirm']) . '"'
            . ' title="' . $esc('Hard reset: ' . $defaultOption['label'] . ' (the arrow lists the other options)') . '">'
            . '⟳ ' . $esc($menu['mainLabel']) . '</button>'
            . '<button type="button" class="' . $esc($btnClass) . ' danger reboot-caret" aria-haspopup="true" aria-expanded="false"'
            . ' aria-label="More reboot options" title="More reboot options">▾</button>'
            . '<span class="reboot-list" role="menu" hidden>' . $items . '</span>'
            . '</span>'
            . '<span class="switch-note reboot-note" role="status"></span>'
            . '</span>';
    }

    // ── The two simple camera pages (simple-list.php, simple-view.php) ──
    // Whole pages as text. Their behaviour lives in js/simple-logic.js (the rules, unit tested) and
    // js/simple-list.js / js/simple-view.js (the page glue); nothing here is script, and everything that
    // comes from config.php is escaped. Camera data reaches the scripts as one data-* attribute.

    private static function esc($s): string
    {
        return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    // The URL of a camera's live picture / of its large view.
    private static function streamUrl(string $id): string
    {
        return 'stream.php?cam=' . rawurlencode($id);
    }

    private static function simpleViewUrl(string $id): string
    {
        return 'simple-view.php?cam=' . rawurlencode($id);
    }

    // The frame both simple pages share: the dashboard's look, a title, $body, and the scripts (file names in js/).
    private static function simplePage(string $title, string $bodyClass, string $body, array $scripts): string
    {
        $tags = '';
        foreach ($scripts as $file) {
            $tags .= '<script src="js/' . self::esc($file) . '"></script>' . "\n";
        }
        return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n"
            . "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
            . '<title>' . self::esc($title) . " — ESP32-CAM Dashboard</title>\n"
            . '<link rel="stylesheet" href="fonts/fonts.css">' . "\n"
            . "<style>\n" . self::simpleCss() . "</style>\n</head>\n"
            . '<body class="' . self::esc($bodyClass) . "\">\n" . $body . "\n" . $tags
            . self::storageWarningScript() . "\n</body>\n</html>\n";
    }

    private static function simpleCss(): string
    {
        return <<<'CSS'
  :root { --bg: #0b0e14; --surface: #111520; --border: #1e2840; --border-light: #3c4d80; --accent: #00e5ff; --accent2: #ff4f5e;
          --text: #cdd8f0; --muted: #7c8ab0; --mono: 'Share Tech Mono', ui-monospace, monospace; --sans: 'Barlow', system-ui, sans-serif; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); }
  .btn { font-family: var(--mono); font-size: .85rem; letter-spacing: .06em; padding: 8px 16px; background: transparent; color: var(--text);
         border: 1px solid var(--border-light); border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn:hover, .btn:focus-visible { border-color: var(--accent); color: var(--accent); }
  .btn.on { border-color: var(--accent); color: var(--accent); }
  .empty { padding: 48px 24px; font-family: var(--mono); color: var(--muted); }

  /* the list: every camera as a thumbnail; js/simple-list.js sets --thumb-w so they fit the screen */
  .simple-list .bar { display: flex; gap: 12px; align-items: center; padding: 8px 12px; font-family: var(--mono); color: var(--muted); }
  .thumbs { --thumb-w: 160px; display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--thumb-w), 1fr)); gap: 8px; padding: 0 12px 12px; justify-content: center; }
  .thumbs.fitted { grid-template-columns: repeat(var(--cols), var(--thumb-w)); }
  .thumb { position: relative; display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; aspect-ratio: 4 / 3; }
  .thumb:hover, .thumb:focus-visible { border-color: var(--accent); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 8px; font-family: var(--mono); font-size: .8rem; background: rgba(11,14,20,.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* the large view: the picture takes everything the status line leaves */
  .simple-view-root { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .picture { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; background: #000; }
  .picture img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .status { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; padding: 10px 14px; background: var(--surface); border-top: 1px solid var(--border); font-family: var(--mono); font-size: 1.1rem; }
  .status .grow { flex: 1 1 auto; }
  .status .rec-on { color: var(--accent2); }
  .status .rec-off { color: var(--muted); }
CSS . "\n";
    }

    // simple-list.php: every camera as a clickable thumbnail (a link to its large view).
    public static function simpleListPage(array $cameras): string
    {
        $items = '';
        foreach (CamLogic::cameraSummaries($cameras) as $cam) {
            $items .= '<a class="thumb" href="' . self::esc(self::simpleViewUrl($cam['id'])) . '" title="' . self::esc($cam['name']) . '">'
                . '<img src="' . self::esc(self::streamUrl($cam['id'])) . '" alt="' . self::esc($cam['name']) . '">'
                . '<span class="cap">' . self::esc($cam['name']) . '</span></a>';
        }
        $body = '<div class="bar"><a class="btn" href="./">← DASHBOARD</a><span>' . count($cameras) . ' CAMERA' . (count($cameras) === 1 ? '' : 'S') . '</span></div>'
            . ($items === '' ? '<p class="empty">No cameras are configured.</p>' : '<main class="thumbs" id="thumbs" data-count="' . count($cameras) . '">' . $items . '</main>');
        return self::simplePage('Cameras', 'simple-list', $body, ['simple-logic.js', 'simple-list.js']);
    }

    // simple-view.php: one camera large, the pager, the status line and the slideshow button.
    // $current: the camera shown first (one of $cameras, or null when there are none).
    public static function simpleViewPage(array $cameras, ?array $current, int $slideshowSeconds): string
    {
        if ($current === null) {
            return self::simplePage('Camera', 'simple-view', '<p class="empty">No cameras are configured.</p><p class="empty"><a class="btn" href="./">← DASHBOARD</a></p>', []);
        }
        $summary = CamLogic::cameraSummaries([$current])[0];
        $data = ' data-cameras="' . self::esc(json_encode(CamLogic::cameraSummaries($cameras), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) . '"'
            . ' data-current="' . self::esc($summary['id']) . '"'
            . ' data-slideshow-seconds="' . $slideshowSeconds . '"';
        $body = '<div class="simple-view-root" id="view"' . $data . '>'
            . '<div class="picture"><img id="picture" src="' . self::esc(self::streamUrl($summary['id'])) . '" alt="' . self::esc($summary['name']) . '"></div>'
            . '<div class="status" role="status">'
            . '<button class="btn" type="button" id="prev" title="Previous camera">← PREV</button>'
            . '<button class="btn" type="button" id="next" title="Next camera">NEXT →</button>'
            . '<span id="clock">--:--:--</span>'
            . '<span id="cam-name">' . self::esc($summary['name']) . '</span>'
            . '<span id="rec" class="rec-off">RECORDING: –</span>'
            . '<span class="grow"></span>'
            . '<button class="btn" type="button" id="slideshow" aria-pressed="false" title="Show the cameras one after the other, every ' . $slideshowSeconds . ' s (set on the SETTINGS page); a camera that records or sees motion is shown first">▶ SLIDESHOW</button>'
            . '<a class="btn" href="simple-list.php">▦ LIST</a>'
            . '<a class="btn" href="./">DASHBOARD</a>'
            . '</div></div>';
        return self::simplePage($summary['name'], 'simple-view', $body, ['simple-logic.js', 'simple-view.js']);
    }

    // What logout.php shows. It is sent with a 401 and a login prompt (that is what makes the browser
    // forget the login — HTTP Basic Auth has no other way), so the page has to explain that prompt.
    public static function loggedOutPage(): string
    {
        return <<<'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Logged out — ESP32-CAM Dashboard</title>
<style>
  body { margin: 0; min-height: 100vh; background: #0b0e14; color: #cdd8f0; font-family: system-ui, sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 64px 24px; }
  h1 { font-family: ui-monospace, monospace; font-size: 1.1rem; letter-spacing: .12em; color: #00e5ff; }
  p { line-height: 1.5; margin: 14px 0; }
  .note { font-size: .85rem; color: #7c8ab0; }
  a.btn { display: inline-block; font-family: ui-monospace, monospace; font-size: .8rem; letter-spacing: .06em; padding: 8px 16px;
          border: 1px solid #3c4d80; border-radius: 6px; color: #cdd8f0; text-decoration: none; }
  a.btn:hover { border-color: #00e5ff; color: #00e5ff; }
</style>
</head>
<body>
<main>
  <h1>⏻ LOGGED OUT</h1>
  <p>This browser was told to forget the dashboard login.</p>
  <p>It may now show a login prompt. <strong>Press Cancel</strong> to stay logged out; a login typed into that prompt only asks for this page again.</p>
  <p><a class="btn" href="./">LOG IN AGAIN</a></p>
  <p class="note">Browsers differ in how well they forget a login. To be sure, close every window of this browser (Tor Browser: New Identity).</p>
</main>
</body>
</html>
HTML;
    }
}
