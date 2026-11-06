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

camtest_test('allFilesLink is a plain link to all-recordings.php that needs no JavaScript', function () {
    $html = CamLayout::allFilesLink('btn');
    camtest_assert_true(strpos($html, '<a ') === 0 && substr($html, -4) === '</a>');
    camtest_assert_true(strpos($html, 'href="all-recordings.php"') !== false);
    camtest_assert_true(strpos($html, 'class="btn"') !== false);
    camtest_assert_true(strpos($html, 'ALL FILES') !== false);
    camtest_assert_true(!preg_match('/<script|\bon[a-z]+\s*=|javascript:/i', $html));
});

camtest_test('allFilesLink escapes the class it is given', function () {
    $html = CamLayout::allFilesLink('x" onclick="alert(1)');
    camtest_assert_true(strpos($html, 'onclick="alert') === false, 'the quote cannot end the attribute');
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
    camtest_assert_equal(substr_count($html, 'class="thumb"'), 2);
    camtest_assert_true(strpos($html, 'href="simple-view.php?cam=cam1"') !== false);
    camtest_assert_true(strpos($html, 'src="stream.php?cam=cam-2"') !== false);
    camtest_assert_true(strpos($html, 'Front Door') !== false && strpos($html, 'Garage') !== false);
    camtest_assert_true(strpos($html, 'data-count="2"') !== false);
    camtest_assert_true(strpos($html, '2 CAMERAS') !== false);
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
    camtest_assert_equal(preg_match_all('/<script\b/i', $html), 3, 'only our two script files and the storage warning');
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
    camtest_assert_true(strpos($html, 'href="simple-list.php"') !== false && strpos($html, 'href="./"') !== false, 'ways back');
    camtest_assert_true(strpos($html, '<script src="js/simple-view.js">') !== false && strpos($html, 'js/simple-logic.js') !== false);
});

camtest_test('simpleViewPage: the scripts get the camera list, the current camera and the slideshow time as data attributes', function () use ($SIMPLE_CAMS) {
    $html = CamLayout::simpleViewPage($SIMPLE_CAMS, $SIMPLE_CAMS[0], 25);
    camtest_assert_true(preg_match('/id="view" data-cameras="([^"]*)" data-current="([^"]*)" data-slideshow-seconds="(\d+)"/', $html, $m) === 1);
    camtest_assert_equal(json_decode(html_entity_decode($m[1], ENT_QUOTES), true), [['id' => 'cam1', 'name' => 'Front Door'], ['id' => 'cam-2', 'name' => 'Garage']]);
    camtest_assert_equal($m[2], 'cam1');
    camtest_assert_equal($m[3], '25');
    camtest_assert_true(strpos($html, 'secret-relay') === false, 'only id and name leave the server');
});

camtest_test('simpleViewPage: a hostile camera name or id stays text, in the page and in the data attribute', function () use ($HOSTILE) {
    $html = CamLayout::simpleViewPage($HOSTILE, $HOSTILE[0], 10);
    camtest_assert_true(strpos($html, '<script>window.__pwned') === false);
    camtest_assert_equal(layout_handler_attributes($html), [], 'no handler attribute on any element');
    camtest_assert_equal(preg_match_all('/<script\b/i', $html), 4);   // simple-logic.js, fullscreen.js, simple-view.js and the storage warning
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
    camtest_assert_true(strpos($html, '<div class="picture" id="picture-box"><img id="picture"') !== false, 'the image is inside the box the script makes full screen');
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

exit(camtest_summarize());
