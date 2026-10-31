<?php
// logout.php — what the dashboard's LOG OUT button posts to.
//
// The dashboard's login is HTTP Basic Auth, and the browser (not the server) holds it: there is no
// session to destroy. The one thing a server can do is answer with a 401 and a login prompt for the
// same realm — a browser that sent a saved login and gets that answer forgets the saved login. So
// this endpoint answers 401 on purpose, with a page that says "logged out" (the page stays visible
// if the owner presses Cancel on the prompt). Nothing is stored on the server.
//
//   - auth.php first, like every endpoint: a request without a valid login just gets the normal
//     login prompt. A good logout counts as neither a failed nor a new login for the guess throttle.
//   - POST from the dashboard's own origin only (CamLogic::logoutRefusalStatus): 405 for anything
//     else, 403 for a request another website caused — and neither of them logs the browser out.
//   - The realm in the 401 is the one auth.php uses (CamLogic::basicChallengeHeader), or the
//     browser would keep the login.

require_once __DIR__ . '/auth.php';      // dashboard login; also defines $config
require_once __DIR__ . '/lib/Layout.php';

$refused = CamLogic::logoutRefusalStatus($_SERVER);
if ($refused !== null) {
    http_response_code($refused);
    header('Content-Type: text/plain');
    if ($refused === 405) {
        header('Allow: POST');
        exit('Use the LOG OUT button on the dashboard.');
    }
    exit('Refused: the request did not come from the dashboard.');
}

error_log('camdash audit: ' . CamLogic::buildActor((string) ($_SERVER['PHP_AUTH_USER'] ?? ''), (string) ($_SERVER['REMOTE_ADDR'] ?? '')) . ' logged out');

http_response_code(401);
header(CamLogic::basicChallengeHeader());
header('Content-Type: text/html; charset=utf-8');
echo CamLayout::loggedOutPage();
