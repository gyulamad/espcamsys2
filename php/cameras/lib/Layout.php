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
