<?php
require_once __DIR__ . '/framework.php';
require_once __DIR__ . '/../../php/cameras/lib/Logic.php';
require_once __DIR__ . '/../../php/cameras/lib/Layout.php';

// ── logoutForm ───────────────────────────────────────────────────────

camtest_test('logoutForm is a POST form to logout.php with one submit button', function () {
    $html = CamLayout::logoutForm();
    camtest_assert_true(strpos($html, '<form ') === 0 && substr($html, -7) === '</form>', 'one form, nothing around it');
    camtest_assert_true(strpos($html, 'method="post"') !== false, 'must POST: a link could be triggered by another website');
    camtest_assert_true(strpos($html, 'action="logout.php"') !== false);
    camtest_assert_equal(substr_count($html, '<button'), 1);
    camtest_assert_true(strpos($html, 'type="submit"') !== false);
    camtest_assert_true(strpos($html, 'LOG OUT') !== false);
});

camtest_test('logoutForm needs no JavaScript and carries nothing a page could be tricked by', function () {
    $html = CamLayout::logoutForm();
    camtest_assert_true(!preg_match('/<script|\bon[a-z]+\s*=|javascript:|href=/i', $html), 'no script, no inline handler, no link');
    camtest_assert_true(!preg_match('/<input/i', $html), 'no fields: nothing to forge, nothing to leak');
});

camtest_test('logoutForm: the button class is a parameter, and is escaped', function () {
    camtest_assert_true(strpos(CamLayout::logoutForm(), '<button class="btn"') !== false, 'default: a normal button');
    camtest_assert_true(strpos(CamLayout::logoutForm('nav-link nav-logout'), '<button class="nav-link nav-logout"') !== false);
    camtest_assert_true(strpos(CamLayout::logoutForm('x" onclick="alert(1)'), 'onclick="alert') === false, 'the quote cannot end the attribute');
});

// ── storageWarningScript ─────────────────────────────────────────────

camtest_test('storageWarningScript is one script that asks storage.php and alerts the server\'s own message', function () {
    $html = CamLayout::storageWarningScript();
    camtest_assert_true(strpos($html, '<script>') === 0 && substr($html, -9) === '</script>', 'one script, nothing around it');
    camtest_assert_equal(substr_count($html, '<script'), 1);
    camtest_assert_true(strpos($html, "fetch('storage.php'") !== false, 'asks storage.php');
    camtest_assert_true(strpos($html, 'alert(d.message)') !== false, 'shows the message in an alert box');
});

camtest_test('storageWarningScript only alerts for a real low answer with a text message, and never reports its own failure', function () {
    $html = CamLayout::storageWarningScript();
    camtest_assert_true(strpos($html, 'd.low === true') !== false, 'strict: only an actual true');
    camtest_assert_true(strpos($html, "typeof d.message === 'string'") !== false, 'only text');
    camtest_assert_true(strpos($html, '.catch(function () {})') !== false, 'a failed request is silent');
    camtest_assert_true(strpos($html, 'r.ok ?') !== false, 'an error status is not read as a warning');
});

camtest_test('storageWarningScript asks with the login, never from cache, and writes nothing into the page', function () {
    $html = CamLayout::storageWarningScript();
    camtest_assert_true(strpos($html, "credentials: 'same-origin'") !== false);
    camtest_assert_true(strpos($html, "cache: 'no-store'") !== false);
    camtest_assert_true(!preg_match('/innerHTML|document\.write|eval\(|localStorage/', $html), 'the message goes to alert() only');
});

// ── rebootMenu ───────────────────────────────────────────────────────

require_once __DIR__ . '/../../php/cameras/lib/Logic.php';

camtest_test('rebootMenu: a split button — main button runs the default, the arrow opens a list with every target', function () {
    $html = CamLayout::rebootMenu(CamLogic::rebootMenu('system'), 'btn');
    camtest_assert_equal(substr_count($html, 'reboot-main'), 1);
    camtest_assert_equal(substr_count($html, 'reboot-caret'), 1);
    camtest_assert_equal(substr_count($html, 'role="menuitem"'), 4, 'one list entry per target');
    camtest_assert_true(preg_match('/class="btn danger reboot-main" data-target="all"/', $html) === 1, 'the main button is the default target');
    camtest_assert_true(strpos($html, '⟳ REBOOT ALL') !== false);
    camtest_assert_true(preg_match('/<span class="reboot-list" role="menu" hidden>/', $html) === 1, 'the list starts closed');
    camtest_assert_true(strpos($html, 'aria-expanded="false"') !== false);
    camtest_assert_equal(substr_count($html, 'reboot-item default'), 1, 'exactly one entry is marked as the default');
});

camtest_test('rebootMenu: lists every target of the menu, in order, with its label', function () {
    $html = CamLayout::rebootMenu(CamLogic::rebootMenu('camera'), 'cam-btn', 'cam1');
    camtest_assert_true(preg_match_all('/class="reboot-item[^"]*" data-target="([a-z]+)"/', $html, $m) === 3);
    camtest_assert_equal($m[1], ['camera', 'detector', 'both']);
    foreach (['RESET CAMERA', 'RESET DETECTOR', 'RESET (BOTH)'] as $label) {
        camtest_assert_true(strpos($html, '>' . $label . '</button>') !== false, "$label is listed");
    }
});

camtest_test('rebootMenu: the style class and the camera id are the caller\'s; the system menu has no camera', function () {
    $card = CamLayout::rebootMenu(CamLogic::rebootMenu('camera'), 'cam-btn', 'cam1');
    camtest_assert_true(strpos($card, 'class="reboot-menu" data-cam="cam1"') !== false);
    camtest_assert_true(strpos($card, 'class="cam-btn danger reboot-main"') !== false && strpos($card, 'class="btn ') === false);
    $header = CamLayout::rebootMenu(CamLogic::rebootMenu('system'), 'btn');
    camtest_assert_true(strpos($header, 'class="reboot-menu">') !== false && strpos($header, 'data-cam') === false);
});

camtest_test('rebootMenu: every action carries its confirmation text, line breaks kept', function () {
    $menu = CamLogic::rebootMenu('system');
    $html = CamLayout::rebootMenu($menu, 'btn');
    camtest_assert_equal(substr_count($html, 'data-confirm="'), 5, 'the main button and the four list entries');
    camtest_assert_true(strpos($html, '&#10;') !== false, 'a line break is written as &#10; so the attribute keeps it');
    camtest_assert_true(strpos($html, "\n") === false, 'no raw line break inside the markup');
});

camtest_test('rebootMenu: needs no inline script and escapes what it is given', function () {
    $html = CamLayout::rebootMenu(CamLogic::rebootMenu('camera'), 'cam-btn', '"><script>alert(1)</script>');
    camtest_assert_true(!preg_match('/<script|\bon[a-z]+\s*=|javascript:/i', $html), 'no script, no inline handler');
    camtest_assert_true(strpos($html, '&quot;&gt;&lt;script&gt;') !== false, 'the camera id is escaped');
    $menu = ['default' => 'x', 'mainLabel' => '<b>M</b>', 'options' => ['x' => ['label' => '<i>L</i>', 'confirm' => "a \"quoted\" <text>"]]];
    $html = CamLayout::rebootMenu($menu, 'btn');
    camtest_assert_true(strpos($html, '<b>') === false && strpos($html, '<i>') === false, 'labels are text, never markup');
    camtest_assert_true(strpos($html, 'a &quot;quoted&quot; &lt;text&gt;') !== false, 'the confirmation text is escaped');
});

// ── loggedOutPage ────────────────────────────────────────────────────

camtest_test('loggedOutPage says logged out and links back to the dashboard', function () {
    $html = CamLayout::loggedOutPage();
    camtest_assert_true(strpos($html, '<!DOCTYPE html>') === 0);
    camtest_assert_true(stripos($html, 'LOGGED OUT') !== false);
    camtest_assert_true(strpos($html, 'href="./"') !== false, 'a way back to the dashboard folder (".../camdash/")');
    camtest_assert_true(strpos($html, 'index.php') === false, 'never the .../index.php address: the browser does not ask for the login again there');
});

camtest_test('loggedOutPage explains the login prompt that comes with it', function () {
    $html = CamLayout::loggedOutPage();
    camtest_assert_true(stripos($html, 'Cancel') !== false, 'tells the owner to press Cancel');
    camtest_assert_true(stripos($html, 'close every window') !== false, 'admits browsers differ and says how to be sure');
});

camtest_test('loggedOutPage is self-contained: no script, no outside resource', function () {
    $html = CamLayout::loggedOutPage();
    camtest_assert_true(!preg_match('/<script|https?:\/\/|@import|<link|<img|<iframe/i', $html));
});

// ── recordingsListStyle / recordingsListScript / allFilesLink ────────

camtest_test('recordingsListStyle holds the footage list and its small buttons, and is only CSS', function () {
    $css = CamLayout::recordingsListStyle();
    foreach (['.cam-btn {', '.files-panel {', '.files-panel.open', '.files-row', '.files-cam', '.files-row.unseen', '.files-panel-footer', '.files-player video'] as $needle) {
        camtest_assert_true(strpos($css, $needle) !== false, $needle . ' is styled');
    }
    camtest_assert_true(!preg_match('/<|@import|url\(|expression\(/i', $css), 'no markup, no import, no external file');
});

camtest_test('recordingsListScript is the list script with the file-name rule of CamLogic, in one <script>', function () {
    $html = CamLayout::recordingsListScript();
    camtest_assert_true(strpos($html, '<script>') === 0 && substr($html, -9) === '</script>', 'one script, nothing around it');
    camtest_assert_equal(substr_count($html, '<script'), 1);
    camtest_assert_equal(substr_count($html, '</script'), 1, 'nothing inside can end the script early');
    camtest_assert_true(strpos($html, 'CamRecordingsList') !== false, 'the list code is there');
    camtest_assert_true(strpos($html, 'CamRecordingsList.SAFE_FILENAME = new RegExp(') !== false, 'the rule is set from PHP');
    camtest_assert_true(strpos($html, json_encode(CamLogic::SAFE_FILENAME_REGEX, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES)) !== false, 'and it is the one CamLogic has');
});

camtest_test('recordingsListScript never builds markup from text (no innerHTML, document.write, eval)', function () {
    camtest_assert_true(!preg_match('/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/', CamLayout::recordingsListScript()));
});

// ── the simple camera pages ──────────────────────────────────────────

// The names of every attribute that is an event handler (onclick, onerror ...) on any element of the page,
// found by parsing it the way a browser would — text that merely contains "onerror=" inside an escaped
// attribute value is not a handler.
function layout_handler_attributes(string $html): array
{
    $doc = new DOMDocument();
    @$doc->loadHTML('<?xml encoding="UTF-8">' . $html);
    $found = [];
    foreach ($doc->getElementsByTagName('*') as $el) {
        foreach ($el->attributes as $attr) {
            if (stripos($attr->name, 'on') === 0) {
                $found[] = $el->nodeName . '@' . $attr->name;
            }
        }
    }
    return $found;
}

$SIMPLE_CAMS = [
    ['id' => 'cam1', 'name' => 'Front Door', 'url' => 'http://secret-relay:8080'],
    ['id' => 'cam-2', 'name' => 'Garage'],
];
$HOSTILE = [['id' => 'cam1', 'name' => '"><script>window.__pwned=1</script>'], ['id' => 'a.b-c', 'name' => "x' onerror='alert(1)"]];

camtest_test('simpleListPage: one thumbnail per camera, a live picture that links to its large view', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleListPage($SIMPLE_CAMS);
    camtest_assert_true(strpos($html, '<!DOCTYPE html>') === 0);
    camtest_assert_equal(substr_count($html, 'class="thumb rec-frame"'), 2);
    camtest_assert_true(strpos($html, 'href="simple-view.php?cam=cam1"') !== false);
    camtest_assert_true(strpos($html, 'src="stream.php?cam=cam-2"') !== false);
    camtest_assert_true(strpos($html, 'Front Door') !== false && strpos($html, 'Garage') !== false);
    camtest_assert_true(strpos($html, 'data-count="2"') !== false);
    camtest_assert_true(strpos($html, '2 CAMERAS') !== false);
});

camtest_test('simpleListPage: every thumbnail has its own hidden loading cover (shown by the script for a camera that is not connected)', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleListPage($SIMPLE_CAMS);
    camtest_assert_equal(substr_count($html, '<div class="cam-loading" role="status" hidden>'), 2);
    camtest_assert_equal(preg_match_all('/<a class="thumb rec-frame"[^>]*><img [^>]*><div class="cam-loading"/', $html), 2, 'inside each thumbnail, over its picture');
    camtest_assert_true(strpos($html, '.cam-loading[hidden] { display: none; }') !== false, 'hidden stays hidden although the cover has its own display');
    camtest_assert_true(strpos($html, 'pointer-events: none') !== false, 'a click goes through the cover');
});

camtest_test('simpleViewPage: the loading cover is inside the picture box (so it goes full screen with it), hidden at first', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[1], 15);
    camtest_assert_equal(preg_match('/<div class="picture rec-frame" id="picture-box"><img [^>]*><div class="cam-loading" id="loading" role="status" hidden>.*?<\/div><\/div>/', $html), 1);
    camtest_assert_equal(substr_count($html, 'id="loading"'), 1);
});

camtest_test('simpleListPage: loads the logic and the list script, links the storage warning, leaks no relay address', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleListPage($SIMPLE_CAMS);
    camtest_assert_true(strpos($html, '<script src="js/simple-logic.js">') !== false);
    camtest_assert_true(strpos($html, '<script src="js/simple-list.js">') !== false);
    camtest_assert_true(strpos($html, "fetch('storage.php'") !== false);
    camtest_assert_true(strpos($html, 'secret-relay') === false, 'the relay address is not the browser\'s business');
    camtest_assert_true(strpos($html, 'href="fonts/fonts.css"') !== false && !preg_match('/googleapis|gstatic/', $html));
});

camtest_test('simpleListPage: one camera says CAMERA, none says so and has no grid', function () {
    camtest_assert_true(strpos(CamLayout::simpleListPage([['id' => 'x', 'name' => 'X']]), '1 CAMERA<') !== false);
    $html = CamLayout::simpleListPage([]);
    camtest_assert_true(strpos($html, 'No cameras are configured') !== false);
    camtest_assert_true(strpos($html, 'id="thumbs"') === false);
});

camtest_test('simpleListPage: a hostile camera name or id never becomes markup, script or an inline handler', function () use ($HOSTILE) {
    $html = CamLayout::simpleListPage($HOSTILE);
    camtest_assert_true(strpos($html, '<script>window.__pwned') === false, 'escaped');
    camtest_assert_true(strpos($html, '&quot;&gt;&lt;script&gt;') !== false);
    camtest_assert_equal(layout_handler_attributes($html), [], 'no handler attribute on any element');
    camtest_assert_equal(preg_match_all('/<script\b/i', $html), 4, 'only our three script files and the storage warning');
});

camtest_test('simpleListPage: an id is URL-encoded in the links', function () {
    $html = CamLayout::simpleListPage([['id' => 'a b&c', 'name' => 'x']]);
    camtest_assert_true(strpos($html, 'simple-view.php?cam=a%20b%26c') !== false);
    camtest_assert_true(strpos($html, 'stream.php?cam=a%20b%26c') !== false);
});

camtest_test('simpleViewPage: the picture, pager, status line and slideshow button for the chosen camera', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[1], 15);
    camtest_assert_true(strpos($html, '<img id="picture" src="stream.php?cam=cam-2"') !== false);
    foreach (['id="prev"', 'id="next"', 'id="clock"', 'id="cam-name">Garage<', 'id="rec"', 'id="slideshow"'] as $needle) {
        camtest_assert_true(strpos($html, $needle) !== false, $needle);
    }
    camtest_assert_true(strpos($html, 'RECORDING: –') !== false, 'unknown until the relay has been asked');
    camtest_assert_true(strpos($html, '<title>Garage — ESP32-CAM Dashboard</title>') !== false);
    camtest_assert_true(strpos($html, 'class="nav-link" href="simple-list.php"') !== false && strpos($html, 'class="nav-link" href="./?layout=grid"') !== false, 'the navigation bar leads to the other pages');
    camtest_assert_true(strpos($html, '>▦ LIST<') === false && strpos($html, '>DASHBOARD<') === false, 'no second copy of those links in the status line');
    camtest_assert_true(strpos($html, '<script src="js/simple-view.js">') !== false && strpos($html, 'js/simple-logic.js') !== false);
});

camtest_test('simpleViewPage: the scripts get the camera list, the current camera and the slideshow time as data attributes', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 25);
    camtest_assert_true(preg_match('/id="view" data-cameras="([^"]*)" data-current="([^"]*)" data-slideshow-seconds="(\d+)"/', $html, $m) === 1);
    camtest_assert_equal(json_decode(html_entity_decode($m[1], ENT_QUOTES), true), [['id' => 'cam1', 'name' => 'Front Door', 'icon' => '📷'], ['id' => 'cam-2', 'name' => 'Garage', 'icon' => '📷']]);
    camtest_assert_equal($m[2], 'cam1');
    camtest_assert_equal($m[3], '25');
    camtest_assert_true(strpos($html, 'secret-relay') === false, 'only id and name leave the server');
});

camtest_test('simpleViewPage: a hostile camera name or id stays text, in the page and in the data attribute', function () use ($HOSTILE) {
    $html = CamLayout::simpleViewPage($HOSTILE, $HOSTILE[0], 10);
    camtest_assert_true(strpos($html, '<script>window.__pwned') === false);
    camtest_assert_equal(layout_handler_attributes($html), [], 'no handler attribute on any element');
    camtest_assert_equal(preg_match_all('/<script\b/i', $html), 5);   // simple-logic.js, fullscreen.js, simple-view.js and the storage warning
    preg_match('/data-cameras="([^"]*)"/', $html, $m);
    camtest_assert_equal(json_decode(html_entity_decode($m[1], ENT_QUOTES), true)[0]['name'], $HOSTILE[0]['name'], 'the data survives the round trip exactly');
    $html = CamLayout::simpleViewPage($HOSTILE, $HOSTILE[1], 10);
    camtest_assert_true(strpos($html, "x' onerror=") === false && strpos($html, 'x&#039; onerror=&#039;alert(1)') !== false);
});

camtest_test('simpleViewPage: no cameras gives a plain notice and no scripts; a nameless camera is shown by its id', function () {
    $html = CamLayout::simpleViewPage([], null, 10);
    camtest_assert_true(strpos($html, 'No cameras are configured') !== false);
    camtest_assert_true(strpos($html, 'id="picture"') === false && strpos($html, 'js/simple-view.js') === false);
    $one = [['id' => 'solo']];
    camtest_assert_true(strpos(CamLayout::simpleViewPage($one, $one[0], 10), 'id="cam-name">solo<') !== false);
});

camtest_test('the simple pages carry the storage warning like every other page with the dashboard look', function () use ($SIMPLE_CAMS) {
    camtest_assert_true(strpos(CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10), "fetch('storage.php'") !== false);
    camtest_assert_true(strpos(CamLayout::simpleListPage([]), "fetch('storage.php'") !== false);
});

// The look of the simple pages is pinned where a regression was reported: a link's caption took the browser's
// blue on the dark page, and a big screen showed the stream at its own small size instead of filling the room.
function layout_css_rule(string $html, string $selector): string
{
    return preg_match('/(?:^|\s|\})' . preg_quote($selector, '/') . '\s*\{([^}]*)\}/', $html, $m) === 1 ? $m[1] : '';
}

camtest_test('simple list: the thumbnail link and its caption have their own readable colour, not the browser\'s link blue', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleListPage($SIMPLE_CAMS);
    camtest_assert_true(preg_match('/color:\s*var\(--text\)/', layout_css_rule($html, '.thumb')) === 1, '.thumb sets a colour (an <a> would be blue, and purple once visited)');
    camtest_assert_true(strpos(layout_css_rule($html, '.thumb'), 'text-decoration: none') !== false);
    camtest_assert_true(preg_match('/color:\s*var\(--text\)/', layout_css_rule($html, '.thumb .cap')) === 1, 'the caption too');
});

camtest_test('simple view: the picture fills the whole free area — it is laid over it, not capped at its own size', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    $area = layout_css_rule($html, '.picture');
    $img = layout_css_rule($html, '.picture img');
    camtest_assert_true(strpos($area, 'position: relative') !== false && strpos($area, 'flex: 1 1 auto') !== false && strpos($area, 'min-height: 0') !== false, $area);
    camtest_assert_true(strpos($img, 'position: absolute') !== false && strpos($img, 'width: 100%') !== false && strpos($img, 'height: 100%') !== false, $img);
    camtest_assert_true(strpos($img, 'object-fit: contain') !== false, 'the shape of the stream is kept');
    camtest_assert_true(strpos($img, 'max-width') === false && strpos($img, 'max-height') === false, 'a max-* size can only shrink a picture, never enlarge it');
});

camtest_test('simple view: the picture sits in its own box — the thing that goes full screen — and the page loads the full-screen helper before its own script', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    camtest_assert_true(strpos($html, '<div class="picture rec-frame" id="picture-box"><img id="picture"') !== false, 'the image is inside the box the script makes full screen');
    $helper = strpos($html, '<script src="js/fullscreen.js">');
    $page = strpos($html, '<script src="js/simple-view.js">');
    camtest_assert_true($helper !== false && $page !== false && $helper < $page, 'fullscreen.js is loaded, and before the script that uses it');
    camtest_assert_true(strpos($html, 'title="Click to view full screen"') !== false, 'the picture says what a click does');
});

camtest_test('simple view: a full-screen picture box is black with a zoom-out cursor, in the standard and the WebKit spelling', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    camtest_assert_true(strpos(layout_css_rule($html, '.picture img'), 'cursor: zoom-in') !== false, 'a click enlarges');
    foreach (['.picture:fullscreen', '.picture:-webkit-full-screen'] as $selector) {
        camtest_assert_true(strpos(layout_css_rule($html, $selector), 'background: #000') !== false, $selector);
        camtest_assert_true(strpos(layout_css_rule($html, $selector . ' img'), 'cursor: zoom-out') !== false, $selector . ' img');
    }
});

camtest_test('simple list: the thumbnails still link to the large view, which is where a click goes full screen — no full-screen script here', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleListPage($SIMPLE_CAMS);
    camtest_assert_true(strpos($html, '<script src="js/fullscreen.js">') === false);
});

camtest_test('simpleViewUrl: the one address of a camera\'s large view, encoded (the dashboard\'s pictures link to it)', function () {
    camtest_assert_equal('simple-view.php?cam=cam1', CamLayout::simpleViewUrl('cam1'));
    camtest_assert_equal('simple-view.php?cam=a%20b%26c%3D%22', CamLayout::simpleViewUrl('a b&c="'));
});

camtest_test('recordingFrameStyle: the frame is always there but transparent, blinks red only with the class "recording", and holds still for reduced motion', function () {
    $css = CamLayout::recordingFrameStyle();
    camtest_assert_true(preg_match('/\.rec-frame \{ border: 3px solid transparent; \}/', $css) === 1, 'transparent frame: nothing moves when it lights up');
    camtest_assert_true(strpos($css, '.rec-frame.recording { border-color: var(--accent2); animation: rec-frame-blink') !== false);
    camtest_assert_true(strpos($css, '@keyframes rec-frame-blink') !== false);
    camtest_assert_true(preg_match('/prefers-reduced-motion: reduce\) \{ \.rec-frame\.recording \{ animation: none; \} \}/', $css) === 1);
});

camtest_test('simple view and simple list: the frame style is on the page, and the picture box and every thumbnail wear the frame (and a thumbnail knows its camera)', function () use ($SIMPLE_CAMS) {
    $view = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    $list = CamLayout::simpleListPage($SIMPLE_CAMS);
    foreach ([$view, $list] as $html) {
        camtest_assert_true(strpos($html, '.rec-frame.recording') !== false, 'the frame style is in the page');
        camtest_assert_true(strpos($html, '<script src="js/relay-json.js">') !== false, 'relay-json.js is loaded');
    }
    camtest_assert_true(strpos($view, '<div class="picture rec-frame" id="picture-box">') !== false);
    camtest_assert_equal(substr_count($list, 'class="thumb rec-frame" data-cam="'), count($SIMPLE_CAMS));
    foreach ($SIMPLE_CAMS as $cam) {
        camtest_assert_true(strpos($list, 'data-cam="' . htmlspecialchars($cam['id'], ENT_QUOTES) . '"') !== false, $cam['id']);
    }
});

camtest_test('simple pages: relay-json.js is loaded before the script that uses it', function () use ($SIMPLE_CAMS) {
    foreach ([['simple-view.js', CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10)], ['simple-list.js', CamLayout::simpleListPage($SIMPLE_CAMS)]] as [$script, $html]) {
        $helper = strpos($html, '<script src="js/relay-json.js">');
        $logic = strpos($html, '<script src="js/simple-logic.js">');
        $page = strpos($html, '<script src="js/' . $script . '">');
        camtest_assert_true($helper !== false && $page !== false && $helper < $page, $script);
        camtest_assert_true($logic !== false && $logic < $page, 'simple-logic.js too: ' . $script);
    }
});

camtest_test('simple list: a camera id with markup in it cannot break out of the data-cam attribute', function () {
    $html = CamLayout::simpleListPage([['id' => 'x"><script>1</script>', 'name' => 'Evil', 'icon' => '📷']]);
    camtest_assert_true(strpos($html, '<script>1</script>') === false);
    camtest_assert_true(strpos($html, 'data-cam="x&quot;&gt;&lt;script&gt;1&lt;/script&gt;"') !== false);
});

camtest_test('simple list: every caption starts with the camera\'s own icon (decoration, hidden from screen readers); no icon set = the camera', function () {
    $html = CamLayout::simpleListPage([
        ['id' => 'a', 'name' => 'Front', 'icon' => '🚪'],
        ['id' => 'b', 'name' => 'Back'],
    ]);
    camtest_assert_true(strpos($html, '<span class="cap"><span class="cam-icon" aria-hidden="true">🚪</span>Front</span>') !== false);
    camtest_assert_true(strpos($html, '<span class="cap"><span class="cam-icon" aria-hidden="true">📷</span>Back</span>') !== false);
});

camtest_test('simple view: the icon sits in front of the name in the status line, in an element a script can change; the camera list carries the icons', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    $icon = htmlspecialchars($SIMPLE_CAMS[0]['icon'] ?? '📷', ENT_QUOTES);
    camtest_assert_true(strpos($html, '<span class="cam-title"><span class="cam-icon" id="cam-icon" aria-hidden="true">' . $icon . '</span><span id="cam-name">Front Door</span></span>') !== false);
    camtest_assert_true(strpos($html, '&quot;icon&quot;:') !== false, 'data-cameras has an icon for every camera');
    camtest_assert_true(strpos($html, '.cam-icon {') !== false);
});

camtest_test('simple pages: a hostile icon is plain text, never markup', function () {
    $evil = ['id' => 'a', 'name' => 'N', 'icon' => '<img src=x onerror=alert(1)>'];
    foreach ([CamLayout::simpleListPage([$evil]), CamLayout::simpleViewPage([$evil], $evil, 10)] as $html) {
        camtest_assert_true(strpos($html, '<img src=x') === false);
        camtest_assert_true(strpos($html, '&lt;img src=x onerror=alert(1)&gt;') !== false || strpos($html, '<') !== false);
    }
});

camtest_test('simple view: the slideshow\'s time-left indicator is in the page, hidden until the script shows it — a bar under the picture and the seconds in the status line', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    camtest_assert_true(strpos($html, '<div class="countdown-bar" id="countdown-bar" aria-hidden="true" hidden><div class="countdown-fill" id="countdown-fill"></div></div>') !== false);
    camtest_assert_true(strpos($html, 'id="countdown"') !== false && preg_match('/id="countdown"[^>]*\bhidden>/', $html) === 1);
    camtest_assert_true(strpos($html, 'id="countdown-bar"') < strpos($html, 'class="status"'), 'the bar is under the picture, above the status line');
    camtest_assert_true(strpos($html, 'id="picture-box"') < strpos($html, 'id="countdown-bar"'));
});

camtest_test('simple view: the bar runs out smoothly, and holds still for reduced motion; nothing of it on the list page', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    camtest_assert_true(strpos(layout_css_rule($html, '.countdown-fill'), 'transition: width 1s linear') !== false);
    camtest_assert_true(preg_match('/prefers-reduced-motion: reduce\) \{ \.countdown-fill \{ transition: none; \} \}/', $html) === 1);
    camtest_assert_true(strpos(CamLayout::simpleListPage($SIMPLE_CAMS), 'id="countdown') === false);
});

// ── the navigation bar ───────────────────────────────────────────────

camtest_test('navBar: the pages in a fixed order, as plain links with a hint', function () {
    $html = CamLayout::navBar(null);
    camtest_assert_true(strpos($html, '<nav class="site-nav" aria-label="Pages">') === 0);
    camtest_assert_equal(preg_match_all('/<a class="nav-link" href="([^"]*)" data-nav="([^"]*)"/', $html, $m), 5);
    camtest_assert_equal($m[1], ['./?layout=grid', './?layout=list', 'simple-view.php', 'simple-list.php', 'all-recordings.php']);
    camtest_assert_equal($m[2], ['dashboard-grid', 'dashboard-list', 'simple-view', 'simple-list', 'all-files']);
    camtest_assert_equal(preg_match_all('/<a [^>]* title="[^"]+"/', $html), 5, 'every link says where it goes');
    foreach (['DASHBOARD GRID', 'DASHBOARD LIST', 'SIMPLE VIEW', 'SIMPLE LIST', 'ALL FILES'] as $label) {
        camtest_assert_true(strpos($html, $label . '</a>') !== false, $label);
    }
    camtest_assert_true(strpos($html, 'aria-current') === false && strpos($html, ' current') === false, 'a page that is none of them marks nothing');
});

camtest_test('navBar: LOG OUT is the last thing in the bar, a POST form (not a link) at its right end', function () {
    $html = CamLayout::navBar(null);
    camtest_assert_equal(substr_count($html, '<form '), 1, 'one logout form');
    camtest_assert_true(strpos($html, CamLayout::logoutForm('nav-link nav-logout') . "</nav>\n") !== false, 'after every link, at the end');
    camtest_assert_true(strpos(CamLayout::navBarStyle(), '.site-nav .logout-form { margin-left: auto;') !== false, 'pushed to the right');
});

camtest_test('navBar: the page that shows it is marked (class and aria-current), and only that one', function () {
    $pages = ['dashboard-grid' => './?layout=grid', 'dashboard-list' => './?layout=list', 'simple-view' => 'simple-view.php',
              'simple-list' => 'simple-list.php', 'all-files' => 'all-recordings.php'];
    foreach ($pages as $key => $href) {
        $html = CamLayout::navBar($key);
        camtest_assert_equal(substr_count($html, 'aria-current="page"'), 1, $key);
        camtest_assert_true(strpos($html, '<a class="nav-link current" href="' . $href . '" data-nav="' . $key . '" aria-current="page"') !== false, $key);
    }
    camtest_assert_equal(substr_count(CamLayout::navBar('nonsense'), 'aria-current'), 0, 'an unknown key marks nothing');
});

camtest_test('navBarStyle: stays at the top (sticky), below the full-screen player, with a fixed height the pages leave room for', function () {
    $css = CamLayout::navBarStyle();
    camtest_assert_true(strpos($css, ':root { --nav-h: 44px; }') !== false);
    $rule = layout_css_rule('<style>' . $css . '</style>', '.site-nav');
    foreach (['position: sticky', 'top: 0', 'z-index: 900', 'height: var(--nav-h)'] as $needle) {
        camtest_assert_true(strpos($rule, $needle) !== false, $needle);
    }
    camtest_assert_true(strpos($css, '.nav-link.current') !== false);
});

camtest_test('simple pages: the navigation bar is the first thing in the body, marked for that page, and the style is in the page', function () use ($SIMPLE_CAMS) {
    $list = CamLayout::simpleListPage($SIMPLE_CAMS);
    $view = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10);
    camtest_assert_true(strpos($list, "<body class=\"simple-list\">\n" . CamLayout::navBar('simple-list')) !== false);
    camtest_assert_true(strpos($view, "<body class=\"simple-view\">\n" . CamLayout::navBar('simple-view')) !== false);
    foreach ([$list, $view] as $html) camtest_assert_true(strpos($html, '.site-nav {') !== false);
    // the empty view has it too: the way out of a page with nothing on it
    camtest_assert_true(strpos(CamLayout::simpleViewPage([], null, 10), CamLayout::navBar('simple-view')) !== false);
    camtest_assert_true(strpos(CamLayout::simpleListPage([]), CamLayout::navBar('simple-list')) !== false);
});

camtest_test('simple pages: no second set of links to the dashboard / list / view (the bar is the only one)', function () use ($SIMPLE_CAMS) {
    foreach ([CamLayout::simpleListPage($SIMPLE_CAMS), CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10), CamLayout::simpleViewPage([], null, 10)] as $html) {
        camtest_assert_true(strpos($html, 'class="btn" href=') === false, 'no .btn link left');
        camtest_assert_equal(substr_count($html, 'href="./?layout=grid"'), 1);
        camtest_assert_equal(substr_count($html, 'href="./?layout=list"'), 1);
        camtest_assert_equal(substr_count($html, 'href="all-recordings.php"'), 1);
        camtest_assert_equal(substr_count($html, 'logout.php'), 1, 'LOG OUT only once, in the bar');
    }
});

camtest_test('simple view: the page fills the window below the bar, not the whole window', function () use ($SIMPLE_CAMS) {
    $rule = layout_css_rule(CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 10), '.simple-view-root');
    camtest_assert_true(strpos($rule, 'height: calc(100vh - var(--nav-h))') !== false && strpos($rule, 'height: calc(100dvh - var(--nav-h))') !== false);
    camtest_assert_true(strpos($rule, 'height: 100vh') === false);
});

camtest_test('the logged-out page has no navigation bar (its links would only ask for the login again)', function () {
    camtest_assert_true(strpos(CamLayout::loggedOutPage(), 'site-nav') === false);
});

camtest_test('iconPickerStyle: a bubble under the input that sits above the page, is hidden by the hidden attribute, has an arrow that can be moved, and scrolls its icons', function () {
    $css = CamLayout::iconPickerStyle();
    $rule = static function (string $selector) use ($css): string { return layout_css_rule('<style>' . $css . '</style>', $selector); };
    foreach (['position: absolute', 'z-index: 40', 'top: calc(100% + 10px)', 'max-width: calc(100vw - 24px)'] as $needle) {
        camtest_assert_true(strpos($rule('.icon-bubble'), $needle) !== false, $needle);
    }
    camtest_assert_true(strpos($rule('.icon-bubble[hidden]'), 'display: none') !== false, 'display must not undo hidden');
    camtest_assert_true(strpos($css, 'left: var(--arrow-x, 28px)') !== false, 'the arrow follows the bubble when it is moved onto the screen');
    camtest_assert_true(strpos($rule('.icon-results'), 'overflow-y: auto') !== false && strpos($rule('.icon-results'), 'max-height') !== false);
    camtest_assert_true(strpos($rule('.icon-picker'), 'position: relative') !== false, 'the box the bubble is placed in');
    camtest_assert_true(strpos($css, '.icon-choice.selected') !== false && strpos($css, '.icon-choice:focus-visible') !== false);
});

exit(camtest_summarize());
