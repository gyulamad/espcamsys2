<?php
// Layout.php — the small pieces of HTML that more than one dashboard page shows, so a page does not
// copy them (and a change is made once). Only builds text; no request, no session, no output.
// Unit tested in tests/php/test_layout.php.

require_once __DIR__ . '/Logic.php';

class CamLayout
{
    // The look of the footage list and of the small buttons in it (.cam-btn): one copy, used by the
    // dashboard (index.php) and the all-files page (all-recordings.php). Needs the page's colour variables
    // (--text --muted --seen --border --border-light --accent --accent2 --mono).
    public static function recordingsListStyle(): string
    {
        return <<<'CSS'
  .cam-btn {
    font-family: var(--mono); font-size: .65rem;
    /* An explicit line height: with "normal" the font that draws a button's pictogram sets the button's height
       (the 🗑 of DEL comes from an emoji font with taller metrics on some systems), so DEL stood taller than PLAY
       and GET and, centred in the row, started higher. A fixed line height makes every button the same height
       whichever font draws its glyphs. */
    line-height: 1.2;
    padding: 3px 8px; border-radius: 3px;
    border: 1px solid var(--border-light);
    background: transparent; color: var(--text);
    cursor: pointer; text-decoration: none;
    transition: all .15s; letter-spacing: .04em;
  }
  .cam-btn:hover               { border-color: var(--accent);  color: var(--accent); }
  .cam-btn.danger:hover        { border-color: var(--accent2); color: var(--accent2); }
  .cam-btn.danger              { border-color: #7a2e3a; color: var(--accent2); }
  .cam-btn:disabled            { opacity: .5; cursor: default; }

  /* Recordings list panel */
  .files-panel {
    display: none; flex-direction: column; gap: 4px;
    padding: 8px 14px; border-top: 1px solid var(--border);
    background: rgba(0,0,0,.25);
    font-family: var(--mono); font-size: .62rem; color: var(--muted);
    /* Deliberately NO max-height / overflow: the list is as long as it needs
       to be and the page itself scrolls. A scroll box inside a scrolling page
       is awkward to use on touch devices (the finger scrolls the wrong one). */
  }
  .files-panel.open { display: flex; }
  .files-panel-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding-bottom: 4px; margin-bottom: 2px; border-bottom: 1px solid var(--border);
  }
  /* The archive's own list (what the person check sorted out), set apart from the recordings above it. */
  .files-archive { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 6px 8px; border-left: 2px solid var(--border); }
  .files-archive-title { color: var(--accent); }
  .files-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  /* A row is "seen" (normal weight, gray) unless it carries .unseen. Weight alone is hard to tell apart
     on phones and some browsers, so colour carries the difference too. */
  .files-name { color: var(--seen); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .files-size { color: var(--seen); font-weight: 400; flex-shrink: 0; }
  /* The first person found in a clip, so who is in it is visible without playing it. */
  .files-thumb-btn { padding: 0; border: 0; background: none; flex-shrink: 0; cursor: zoom-in; line-height: 0; }
  .files-thumb { width: 96px; height: auto; border-radius: 3px; border: 1px solid var(--border); }
  /* The picture in large, over the whole page; a click or Escape closes it. */
  .files-lightbox {
    position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; padding: 12px; background: rgba(0, 0, 0, 0.88); cursor: zoom-out;
  }
  .files-lightbox img { max-width: 100%; max-height: calc(100% - 32px); object-fit: contain; }
  .files-lightbox-caption { color: #ddd; font-size: 0.85em; word-break: break-all; text-align: center; }
  /* "processing…" / why a person check failed. */
  .files-scan { color: var(--accent); flex-shrink: 0; font-size: 0.85em; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .files-scan.error { color: #e57373; }
  /* Which camera a clip is from (shown on the all-files page only). */
  /* A fixed-width cell (long names are cut with an ellipsis; the full name is its tooltip), so the person
     thumbnails and everything after them line up in every row, whatever the camera is called. */
  .files-cam { color: var(--accent); flex: 0 0 12ch; width: 12ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Footage nobody has played or downloaded yet is bold and bright. */
  .files-row.unseen .files-name, .files-row.unseen .files-size { color: var(--text); font-weight: 700; }
  .files-select { flex-shrink: 0; margin: 0; cursor: pointer; accent-color: var(--accent2); }
  /* A row's buttons (PLAY / GET / DEL) travel as one box: at the right end of the line on a wide screen ... */
  .files-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
  /* ... and on a small screen, where one line cannot hold a name, a size and three buttons (the name was squeezed
     to nothing and the buttons ran off the edge, starting at a different place in every row), the row wraps:
     the name may use several lines and the buttons get a line of their own, floated right, the same in every row. */
  @media (max-width: 700px) {
    .files-panel-header { flex-wrap: wrap; row-gap: 6px; }   /* its four buttons (with an archive) do not fit one line of a 320 px screen */
    .files-row { flex-wrap: wrap; row-gap: 6px; }
    .files-row + .files-row { border-top: 1px solid var(--border); padding-top: 8px; }   /* with two lines each, the rows need a divider */
    .files-name { flex: 1 1 14ch; min-width: 14ch; white-space: normal; overflow-wrap: anywhere; }
    .files-size { margin-left: auto; }   /* stays at the right even when it wraps onto a line of its own (a row with a person's picture) */
    .files-scan { max-width: 100%; }
    .files-actions { flex: 0 0 100%; justify-content: flex-end; margin-left: 0; }
  }
  /* Bulk actions for the ticked footage sit at the bottom of the list. */
  .files-panel-footer {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding-top: 6px; margin-top: 2px; border-top: 1px solid var(--border);
  }
  .files-empty { color: var(--muted); padding: 4px 0; }
  /* The video window: a clip plays in a modal over the page, as large as the screen allows (a phone's screen
     is too small for a player squeezed in under a row). 100dvh follows the phone's address bar; the safe-area
     padding keeps the controls clear of a notch. The page behind does not scroll while it is open. */
  body.files-modal-open { overflow: hidden; }
  .files-video-modal {
    position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column;
    height: 100vh; height: 100dvh; box-sizing: border-box; background: #000;   /* opaque: the list behind must not ghost through */
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .files-video-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
  .files-video-title { flex: 1; min-width: 0; color: #ddd; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .files-video-close { flex: 0 0 auto; min-width: 44px; min-height: 44px; font-size: 0.85em; }   /* a finger-sized target */
  .files-video-stage { flex: 1 1 auto; min-height: 0; display: flex; }
  .files-video-modal video { width: 100%; height: 100%; object-fit: contain; background: #000; }
CSS;
    }

    // The pages the navigation bar leads to: key (what a page passes as its own), address, label, hint.
    // The dashboard has two entries: its grid and its list layout (the page honours ?layout=, see
    // CamLogic::dashboardLayout()). The bar's links are the only ones to these pages.
    private const NAV_PAGES = [
        ['dashboard-grid', './?layout=grid', '⊞ DASHBOARD GRID', 'All cameras as a grid, with their controls'],
        ['dashboard-list', './?layout=list', '☰ DASHBOARD LIST', 'All cameras as a list, with their controls'],
        ['simple-view', 'simple-view.php', '▣ SIMPLE VIEW', 'One camera large, with PREV / NEXT and a slideshow — for a big screen'],
        ['simple-list', 'simple-list.php', '▦ SIMPLE LIST', 'Every camera as a small picture on one plain page; click one to see it large'],
        ['all-files', 'all-recordings.php', '📼 ALL FILES', 'Every saved recording of every camera in one list, newest first; delete all footage from there'],
    ];

    // The navigation bar at the top of every page after the login: one place to go to the dashboard (grid or
    // list), the simple view, the simple list and the file list (and the only place that has these links), and
    // LOG OUT at its right end. $active: the key of the page that shows it, or null on a page that is none of
    // them (the settings): no link is marked then.
    public static function navBar(?string $active): string
    {
        $links = '';
        foreach (self::NAV_PAGES as [$key, $href, $label, $hint]) {
            $current = $key === $active;
            $links .= '<a class="nav-link' . ($current ? ' current' : '') . '" href="' . self::esc($href) . '" data-nav="' . self::esc($key) . '"' . self::pageLoadAttr()
                . ($current ? ' aria-current="page"' : '') . ' title="' . self::esc($hint) . '">' . self::esc($label) . '</a>';
        }
        return '<nav class="site-nav" aria-label="Pages">' . $links . self::logoutForm('nav-link nav-logout') . "</nav>\n";
    }

    // Its style. It stays at the top of the window while the page scrolls (below a full-screen player, which
    // covers the whole window on purpose, z-index 1000) and has a fixed height (--nav-h), so a page that fills the
    // window (the simple view, the simple list) can leave exactly that much room for it. Needs the page's
    // --surface --border --border-light --text --accent --mono.
    public static function navBarStyle(): string
    {
        return <<<'CSS'
  :root { --nav-h: 44px; }
  .site-nav { position: sticky; top: 0; z-index: 900; display: flex; gap: 8px; align-items: center; height: var(--nav-h); padding: 0 12px;
              background: var(--surface); border-bottom: 1px solid var(--border); font-family: var(--mono); overflow-x: auto; }
  .nav-link { flex: 0 0 auto; padding: 5px 14px; font-size: .85rem; letter-spacing: .06em; color: var(--text); text-decoration: none;
              border: 1px solid var(--border-light); border-radius: 6px; white-space: nowrap; }
  .nav-link:hover, .nav-link:focus-visible { border-color: var(--accent); color: var(--accent); }
  .nav-link.current { border-color: var(--accent); color: var(--accent); background: rgba(0,229,255,.08); }
  .site-nav .logout-form { margin-left: auto; flex: 0 0 auto; }
  .nav-logout { font-family: var(--mono); background: transparent; cursor: pointer; }
CSS . "\n";
    }

    // The style of the icon chooser bubble (js/icon-picker.js) on the settings pages: the input in its box, the
    // bubble under it with the search bar on top and the icons below, a little arrow pointing at the input. Needs the
    // page's --surface --bg --border --border-light --text --muted --accent --mono --radius.
    public static function iconPickerStyle(): string
    {
        return <<<'CSS'
  .icon-picker { position: relative; display: block; flex: 0 0 90px; min-width: 70px; }
  .icon-picker > input.icon { width: 100%; }
  .icon-bubble { position: absolute; z-index: 40; top: calc(100% + 10px); left: 0; width: 336px; max-width: calc(100vw - 24px); padding: 10px;
                 background: var(--surface); border: 1px solid var(--border-light); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.6); }
  .icon-bubble[hidden] { display: none; }
  .icon-bubble::before { content: ''; position: absolute; top: -7px; left: var(--arrow-x, 28px); width: 12px; height: 12px; transform: rotate(45deg);
                         background: var(--surface); border-left: 1px solid var(--border-light); border-top: 1px solid var(--border-light); }
  .icon-bubble input.icon-search { display: block; width: 100%; min-width: 0; flex: none; margin: 0 0 8px; padding: 8px 10px; text-align: left; font-family: var(--mono); font-size: .85rem;
                                   background: var(--bg); color: var(--text); border: 1px solid var(--border-light); border-radius: 18px; }
  .icon-bubble input.icon-search:focus { outline: none; border-color: var(--accent); }
  .icon-results { max-height: 264px; overflow-y: auto; overscroll-behavior: contain; }
  .icon-group { position: sticky; top: 0; padding: 4px 2px; font-family: var(--mono); font-size: .65rem; letter-spacing: .1em; text-transform: uppercase;
                color: var(--muted); background: var(--surface); }
  .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, 40px); gap: 2px; margin-bottom: 6px; }
  .icon-choice { width: 40px; height: 40px; padding: 0; font-size: 1.4rem; line-height: 1; background: transparent; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
  .icon-choice:hover, .icon-choice:focus-visible { background: rgba(0,229,255,.12); border-color: var(--accent); outline: none; }
  .icon-choice.selected { border-color: var(--border-light); background: rgba(0,229,255,.06); }
  .icon-empty { padding: 18px 4px; font-family: var(--mono); font-size: .8rem; color: var(--muted); text-align: center; }
CSS . "\n";
    }

    // The frame around a camera's picture, one copy for the dashboard, the simple view and the simple list.
    // It is always there, so nothing moves when it lights up, but transparent until the camera records: the
    // page then sets the class "recording" on the frame and it blinks red. Needs the page's --accent2.
    public static function recordingFrameStyle(): string
    {
        return <<<'CSS'
  .rec-frame { border: 3px solid transparent; }
  .rec-frame.recording { border-color: var(--accent2); animation: rec-frame-blink 1.2s ease-in-out infinite; }
  @keyframes rec-frame-blink { 0%, 100% { border-color: var(--accent2); } 50% { border-color: transparent; } }
  /* for people who asked their system for less motion a steady red frame says it just as well */
  @media (prefers-reduced-motion: reduce) { .rec-frame.recording { animation: none; } }
CSS . "\n";
    }

    // The footage list's script (lib/recordings-list.js) as one <script>, with the file-name rule of
    // CamLogic. Put it before the page's own script, which calls CamRecordingsList.create(...).
    public static function recordingsListScript(): string
    {
        $js = file_get_contents(__DIR__ . '/recordings-list.js');
        if ($js === false || $js === '') {
            throw new RuntimeException('lib/recordings-list.js is missing: the footage list cannot be drawn');
        }
        $rule = json_encode(CamLogic::SAFE_FILENAME_REGEX, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES);
        return "<script>\n" . $js . "\nCamRecordingsList.SAFE_FILENAME = new RegExp(" . $rule . ");\n</script>";
    }

    // The LOG OUT button. A real <form> POST to logout.php — not a link (a link can be triggered by
    // another website or a prefetch) and not JavaScript (so it works with scripts blocked). The
    // browser's own same-origin headers are what logout.php checks, see CamLogic::logoutRefusalStatus().
    public static function logoutForm(string $btnClass = 'btn'): string
    {
        return '<form class="logout-form" method="post" action="logout.php"' . self::pageLoadAttr('Logging out…') . '>'
            . '<button class="' . self::esc($btnClass) . '" type="submit" title="Log out: this browser forgets the dashboard login">⏻ LOG OUT</button>'
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
            . '</span>';   // the result message is a toast popup (js/toast.js), not a note printed next to the button
    }

    // ── The two simple camera pages (simple-list.php, simple-view.php) ──
    // Whole pages as text. Their behaviour lives in js/simple-logic.js (the rules, unit tested) and
    // js/simple-list.js / js/simple-view.js (the page glue); the mux scripts (js/mux-*.js) load BEFORE the glue, which
    // needs them to exist; nothing here is script, and everything that
    // comes from config.php is escaped. Camera data reaches the scripts as one data-* attribute.

    private static function esc($s): string
    {
        return htmlspecialchars((string) $s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    // The URL of a camera's large view. (There is no URL of a live picture: the pictures arrive on the page's one
    // mux.php connection and are put onto the <img> elements, which therefore have no src when the page is sent.)
    // Public: the dashboard's pictures link to it too, so the address is built in one place.
    public static function simpleViewUrl(string $id): string
    {
        return 'simple-view.php?cam=' . rawurlencode($id);
    }

    // The "camera offline" cover of a picture: a dark but transparent layer over the (stale) last picture of a camera that
    // is not connected, with a spinner, a title and a line saying the camera is being reconnected. Without it that picture
    // stays clear and still, and looks as if all were quiet. Put it inside the box that holds the picture, after the
    // picture; it is hidden until the page's script finds the camera offline (js/camera-offline.js) and it lets clicks
    // through, so a click on the picture still works. $id: an id for the element ('' for none); raw, it is escaped here.
    // The dashboard and both simple pages use this one, with offlineCoverStyle().
    public static function offlineCover(string $id = ''): string
    {
        return '<div class="cam-offline"' . ($id === '' ? '' : ' id="' . self::esc($id) . '"') . ' role="status" hidden>'
            . '<span class="cam-offline-spinner" aria-hidden="true"></span>'
            . '<span class="cam-offline-title">CAMERA OFFLINE</span>'
            . '<span class="cam-offline-note">Reconnecting…</span></div>';
    }

    // The look of offlineCover(). It does not lean on the page's own colours (the dashboard and the simple pages
    // differ), so the message reads the same on both, over any picture. The layer is see-through and drains the colour
    // of what is under it, so the last picture is still there but plainly not live.
    public static function offlineCoverStyle(): string
    {
        return <<<'CSS'
  .cam-offline { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center;
    background: rgba(6,8,16,.68); -webkit-backdrop-filter: grayscale(1); backdrop-filter: grayscale(1);
    font-family: var(--mono, ui-monospace, monospace); text-align: center; padding: 8px; overflow: hidden; pointer-events: none; }
  .cam-offline[hidden] { display: none; }
  .cam-offline-spinner { width: 24px; height: 24px; border: 2px solid #3c4d80; border-top-color: #00e5ff; border-radius: 50%; animation: cam-offline-spin 1s linear infinite; }
  .cam-offline-title { color: #ff4f5e; font-size: .9rem; letter-spacing: .12em; text-shadow: 0 1px 3px #000; }
  .cam-offline-note { color: #cdd8f0; font-size: .75rem; letter-spacing: .06em; text-shadow: 0 1px 3px #000; }
  .thumb .cam-offline { gap: 4px; }
  .thumb .cam-offline-spinner { width: 18px; height: 18px; }
  .thumb .cam-offline-title { font-size: .75rem; }
  .thumb .cam-offline-note { font-size: .65rem; }
  .picture .cam-offline { gap: 12px; }
  .picture .cam-offline-spinner { width: 40px; height: 40px; border-width: 3px; }
  .picture .cam-offline-title { font-size: 1.6rem; }
  .picture .cam-offline-note { font-size: 1.1rem; }
  @keyframes cam-offline-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .cam-offline-spinner { animation-duration: 3s; } }
CSS . "\n";
    }

    // The attribute that tells js/busy.js that a link or a form REPLACES THE PAGE, so it puts the full-screen
    // "loading" cover up on the click. $text: what the cover says ('' for its default, "Loading…"). Put it on an
    // <a> that opens a page of this site in this window, or on a <form> that posts to one; never on a download or a
    // link that opens a new tab (no page comes, so the cover would wait for nothing). Returns it with a space in front.
    public static function pageLoadAttr(string $text = ''): string
    {
        return $text === '' ? ' data-page-load' : ' data-page-load="' . self::esc($text) . '"';
    }

    // The look of what js/busy.js shows, on every page: the rolling spinner in front of the text of a button that
    // is busy (.is-busy) and the full-screen cover of a page that is loading (#page-busy). Like offlineCoverStyle()
    // it does not lean on the page's own colours. The cover is above everything, the full-screen player and the
    // navigation bar included (z-index 1000 / 900), and takes the clicks, so nothing is pressed twice.
    public static function busyStyle(): string
    {
        return <<<'CSS'
  .is-busy { cursor: progress; pointer-events: none; }
  .is-busy::before { content: ''; display: inline-block; box-sizing: border-box; width: .9em; height: .9em; margin-right: .5em; vertical-align: -.12em;
    border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: busy-spin .8s linear infinite; }
  .page-busy { position: fixed; inset: 0; z-index: 2000; display: flex; flex-direction: column; gap: 16px; align-items: center; justify-content: center;
    background: rgba(6,8,16,.72); color: #cdd8f0; font-family: var(--mono, ui-monospace, monospace); font-size: 1rem; letter-spacing: .08em;
    cursor: progress; animation: busy-fade .15s ease-out; }
  .page-busy[hidden] { display: none; }
  .busy-spinner { width: 44px; height: 44px; box-sizing: border-box; border: 3px solid #3c4d80; border-top-color: #00e5ff; border-radius: 50%; animation: busy-spin .8s linear infinite; }
  .page-busy-text { text-shadow: 0 1px 3px #000; }
  @keyframes busy-spin { to { transform: rotate(360deg); } }
  @keyframes busy-fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .is-busy::before, .busy-spinner { animation-duration: 3s; } .page-busy { animation: none; } }
CSS . "\n";
    }

    // The frame both simple pages share: the dashboard's look, a title, $body, and the scripts (file names in js/).
    // $bodyClass is also the page's key in the navigation bar (NAV_PAGES): 'simple-list' or 'simple-view'.
    // The page's icon (favicon.svg for browsers that take a vector icon, favicon.ico for the rest), for the <head> of every
    // page, so that no browser has to ask for /favicon.ico by guessing. The files sit next to the pages.
    public static function faviconLinks(): string
    {
        return '<link rel="icon" href="favicon.svg" type="image/svg+xml">' . "\n"
            . '<link rel="icon" href="favicon.ico" sizes="48x48">' . "\n";
    }

    private static function simplePage(string $title, string $bodyClass, string $body, array $scripts): string
    {
        $tags = '';
        foreach ($scripts as $file) {
            $tags .= '<script src="js/' . self::esc($file) . '"></script>' . "\n";
        }
        return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n"
            . "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
            . '<title>' . self::esc($title) . " — ESP32-CAM Dashboard</title>\n"
            . self::faviconLinks()
            . '<link rel="stylesheet" href="fonts/fonts.css">' . "\n"
            . "<style>\n" . self::simpleCss() . "</style>\n</head>\n"
            . '<body class="' . self::esc($bodyClass) . "\">\n" . self::navBar($bodyClass) . $body . "\n" . $tags
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
  /* an <a>: without its own colour the caption would take the browser's link blue, unreadable on this dark page */
  .thumb { position: relative; display: block; color: var(--text); text-decoration: none; background: var(--surface); border-radius: 6px; overflow: hidden; aspect-ratio: 4 / 3; }
  .thumb:hover, .thumb:focus-visible { border-color: var(--accent); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cam-icon { margin-right: .4em; }
  .thumb .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 8px; font-family: var(--mono); font-size: .85rem; color: var(--text); background: rgba(11,14,20,.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* the large view: the picture takes everything the status line leaves */
  .simple-view-root { height: calc(100vh - var(--nav-h)); height: calc(100dvh - var(--nav-h)); display: flex; flex-direction: column; overflow: hidden; }
  /* The picture fills ALL the room the status line leaves, however big the screen and however small the stream:
     max-width / max-height would only ever shrink it, never enlarge it. The image is laid over the whole area
     and object-fit: contain keeps its shape (black bars where the shapes differ). */
  .picture { position: relative; flex: 1 1 auto; min-height: 0; background: #000; }
  .picture img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; cursor: zoom-in; }
  /* A click on the picture shows it full screen (js/fullscreen.js); the box is what goes full screen, so
     whatever is laid over the picture goes with it. Another click leaves. */
  .picture:fullscreen { background: #000; }
  .picture:-webkit-full-screen { background: #000; }
  .picture:fullscreen img { cursor: zoom-out; }
  .picture:-webkit-full-screen img { cursor: zoom-out; }
  /* the slideshow's "time left" indicator: a thin bar under the picture that runs out, and its seconds in the status line */
  .countdown-bar { flex: 0 0 auto; height: 4px; background: var(--border); }
  .countdown-fill { height: 100%; width: 100%; background: var(--accent); transition: width 1s linear; }
  .status .countdown { color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .countdown-fill { transition: none; } }
  .status { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; padding: 10px 14px; background: var(--surface); border-top: 1px solid var(--border); font-family: var(--mono); font-size: 1.1rem; }
  .status .grow { flex: 1 1 auto; }
  .status .rec-on { color: var(--accent2); }
  .status .rec-off { color: var(--muted); }
CSS . "\n" . self::navBarStyle() . self::recordingFrameStyle() . self::offlineCoverStyle() . self::busyStyle();
    }

    // The camera's icon in front of its name, as the page shows both. The icon is decoration (the name says it
    // all to a screen reader); an element of its own so a script can change it with the name.
    private static function iconSpan(string $icon, string $id = ''): string
    {
        return '<span class="cam-icon"' . ($id === '' ? '' : ' id="' . $id . '"') . ' aria-hidden="true">' . self::esc($icon) . '</span>';
    }

    // simple-list.php: every camera as a clickable thumbnail (a link to its large view); a camera that
    // records has a blinking red frame (js/simple-list.js sets the class).
    public static function simpleListPage(array $cameras): string
    {
        $items = '';
        foreach (CamLogic::cameraSummaries($cameras) as $cam) {
            $items .= '<a class="thumb rec-frame" data-cam="' . self::esc($cam['id']) . '" href="' . self::esc(self::simpleViewUrl($cam['id'])) . '"' . self::pageLoadAttr() . ' title="' . self::esc($cam['name']) . '">'
                . '<img alt="' . self::esc($cam['name']) . '">'
                . self::offlineCover()
                . '<span class="cap">' . self::iconSpan($cam['icon']) . self::esc($cam['name']) . '</span></a>';
        }
        $body = '<div class="bar"><span>' . count($cameras) . ' CAMERA' . (count($cameras) === 1 ? '' : 'S') . '</span></div>'
            . ($items === '' ? '<p class="empty">No cameras are configured.</p>' : '<main class="thumbs" id="thumbs" data-count="' . count($cameras) . '">' . $items . '</main>');
        return self::simplePage('Cameras', 'simple-list', $body, ['busy.js', 'camera-offline.js', 'simple-logic.js', 'mux-codec.js', 'mux-client.js', 'mux-pictures.js', 'simple-list.js']);
    }

    // simple-view.php: one camera large (a click on it shows it full screen), the pager, the status line and
    // the slideshow button. $current: the camera shown first (one of $cameras, or null when there are none).
    public static function simpleViewPage(array $cameras, ?array $current, int $slideshowSeconds): string
    {
        if ($current === null) {
            return self::simplePage('Camera', 'simple-view', '<p class="empty">No cameras are configured.</p>', []);
        }
        $summary = CamLogic::cameraSummaries([$current])[0];
        $data = ' data-cameras="' . self::esc(json_encode(CamLogic::cameraSummaries($cameras), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) . '"'
            . ' data-current="' . self::esc($summary['id']) . '"'
            . ' data-slideshow-seconds="' . $slideshowSeconds . '"';
        $body = '<div class="simple-view-root" id="view"' . $data . '>'
            . '<div class="picture rec-frame" id="picture-box"><img id="picture" alt="' . self::esc($summary['name']) . '" title="Click to view full screen">' . self::offlineCover('offline') . '</div>'
            . '<div class="countdown-bar" id="countdown-bar" aria-hidden="true" hidden><div class="countdown-fill" id="countdown-fill"></div></div>'
            . '<div class="status" role="status">'
            . '<button class="btn" type="button" id="prev" title="Previous camera">← PREV</button>'
            . '<button class="btn" type="button" id="next" title="Next camera">NEXT →</button>'
            . '<span id="clock">--:--:--</span>'
            . '<span class="cam-title">' . self::iconSpan($summary['icon'], 'cam-icon') . '<span id="cam-name">' . self::esc($summary['name']) . '</span></span>'
            . '<span id="rec" class="rec-off">RECORDING: –</span>'
            . '<span class="countdown" id="screen-state" title="Whether this page keeps the device screen on" hidden></span>'
            . '<span class="countdown" id="countdown" title="Time left before the slideshow shows the next camera" hidden></span>'
            . '<span class="grow"></span>'
            . '<button class="btn" type="button" id="slideshow" aria-pressed="false" title="Show the cameras one after the other, every ' . $slideshowSeconds . ' s (set on the SETTINGS page); a camera that records or sees motion is shown first">▶ SLIDESHOW</button>'
            . '</div></div>';
        return self::simplePage($summary['name'], 'simple-view', $body, ['busy.js', 'camera-offline.js', 'simple-logic.js', 'mux-codec.js', 'mux-client.js', 'mux-pictures.js', 'fullscreen.js', 'screen-keeper.js', 'simple-view.js']);
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
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="icon" href="favicon.ico" sizes="48x48">
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
