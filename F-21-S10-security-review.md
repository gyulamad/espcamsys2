# F-21 S10 — Security review of the setup mode (findings)

Scope: the code a phone reaches while a board is in setup mode — `setup_form.h` (parser, form, handler),
`setup_mode.h` (HTTP reader, reply writer, access point, DNS), `setup_logic.h` / `setup_boot.h` /
`setup_session.h` (password choice, session). Branch `setup` at `0a85d24`. Method: reading the code against the
handover's security requirements (§7.3), then randomized testing (`tests/cpp/test_setup_fuzz.cpp`, fixed seed,
also run for hours-equivalent volume under `-fsanitize=address,undefined` with several other seeds), then a
mutation check (planted bugs the fuzzer must catch).

Not covered here: anything that needs the real radio or a phone (S11): captive-portal behaviour, "no internet"
handling, WPA2 association limits, real TCP behaviour, power loss during a flash write.

## Verdict

No way was found to change a board's settings, skip the master-password rule or read a secret without the
master password plus the page's CSRF token. Two small defects in the HTTP reader were found by the fuzzer and
**fixed** in this patch. F3 (DNS rebinding) was **fixed** in a follow-up patch after the ticket owner approved it. One point remains **open** and needs a real board (F4).

## Findings

| # | Severity | Status | What |
|---|---|---|---|
| F1 | Low | **Fixed** | A request head of 2045–2048 bytes was accepted or refused (431) depending on how TCP cut it |
| F2 | Low | **Fixed** | The request target could contain a TAB |
| F3 | Low–Medium | **Fixed (follow-up patch)** | No `Host` check: DNS rebinding against the board's own catch-all DNS |
| F4 | Low | **Open: verify on a board (S11)** | The CSRF token is generated before the radio runs |
| F5 | Info | Accepted, document | Limits that follow from the design |

### F1 — head size cap depended on TCP segmentation (fixed)
`HttpRequestReader::feed` refused a head longer than `SETUP_HEAD_MAX` (2048) as soon as the buffer exceeded that
size without a blank line — but a head of 2048 bytes is followed by `\r\n\r\n`, and up to 3 bytes of that blank
line can already be in the buffer. Whether a head of 2045–2048 bytes was accepted therefore depended on where the
segment boundary fell. No security impact (the cap itself was never exceeded), but the same request got two
different answers. Fix: allow 3 bytes for the partly arrived blank line (`setup_mode.h`, both copies).
Test: `a_request_head_at_the_size_cap_is_judged_by_its_size_not_by_how_it_was_cut` (every possible cut).

### F2 — TAB accepted in the request target (fixed)
The head-wide control-character check allows TAB (legal in header values), so `GET /generate_204<TAB> HTTP/1.1`
was accepted with the TAB inside the target. The form routes by exact match and answered 404, so nothing
followed from it, but a request target must not contain control characters. Fix: refuse control characters in the
target (`parseRequestLine`, both copies). A TAB in a header value is still accepted.
Test: `a_tab_or_other_control_character_in_the_request_target_is_refused_but_a_tab_in_a_header_value_is_fine`.

### F3 — no `Host` check; DNS rebinding (fixed in follow-up patch)
The board's DNS answers **every** name with 192.168.4.1 (needed for the captive portal), and without a `Host`
check, a web page that was open in the phone's browser before it joined the setup WiFi (origin `evil.example`)
can, once the browser's cached address for that name expires, fetch `http://evil.example/` from the board as its
own origin, read the page — including the CSRF token — and POST `/save`: new settings (for example another relay
address) and a master password chosen by the attacker. Unlikely, but the consequence is a takeover.

**Fix (in `setup_mode.h`, `ArduinoSetupNet::serve`):** `HttpRequestReader` now stores the `Host` header
(lowercase). Before the handler is called, `serve()` checks it: `192.168.4.1` and `192.168.4.1:80` are allowed;
an empty host (HTTP/1.0, no `Host` header) is let through; anything else gets a `302` redirect to
`http://192.168.4.1/`. Captive-portal probes keep working because they were already redirected by the form; they
now get the redirect one layer earlier instead.

Test: `a_request_with_a_wrong_host_is_redirected_to_the_board_and_never_reaches_the_handler` in
`test_setup_mode_glue.cpp`. Checks that a wrong-host request is redirected, that the Location header points to
the board, and that the handler was never called for it, while correct-host and no-host requests are served.

### F4 — CSRF token entropy (OPEN — verify on a board)
`newCsrfToken()` uses `esp_random()`. Espressif documents that the hardware RNG is only a true random source
while the Wi-Fi or Bluetooth radio is running; `SetupBoot` builds the form (and so asks for the token) *before*
`startAccessPoint()` turns the radio on, and the sketches run `setupSettings()` before `connectWifi()`. I could not
test this here. If it holds on a board, the token is weaker than the 128 bits it looks like (the same pattern is
in `relay_find.h`, which uses it for a different purpose). Cheapest fix if confirmed: create the token after the
access point is up (a lazily generated token, or a token provider the form calls on first use). S11 should
check it on hardware; the CSRF check itself (constant-time, required on every POST) is verified.

### F5 — limits that follow from the design (document, do not fix)
- Everyone who knows the master password can reconfigure a board in setup; there is no second factor and no
  attempt limit on the form (WPA2 itself limits guessing the password over the air).
- The form is plain HTTP inside WPA2: private from outsiders, not from other holders of the master password.
- A joined phone can occupy all 4 HTTP slots for up to 10 s at a time (slow-loris is bounded, not prevented).
- The CSRF token is the same for the whole boot and is in every form page, by design.
- `SHOW <KEY>` over serial prints secrets unmasked (documented): physical access to the board is out of scope.

## What was checked and held (no change needed)
- **Nothing is stored unless the whole form is valid, and only through a successful `/save` or `/exit`**
  — fuzzed over four board states (blank, configured with its own password, configured with the default
  password, armed) and ~3000 mutated or hostile requests per run.
- **Master-password rule cannot be bypassed:** field missing, empty, default, public default, too short/long,
  non-ASCII, confirmation missing or different — a successful save always stored exactly the typed,
  confirmed, valid, non-default password. The check uses its own copy of the rule, not the code under test.
- **CSRF:** wrong, truncated, extended, empty or missing token → 403 and nothing changes.
- **Injection:** every reply page is parsed back: each `<` opens one of the page's own tags, every attribute is
  double-quoted and none is an event handler or `src`/`href`/`style`. Typed text comes back escaped.
- **No secret in any reply:** stored and typed API key, WiFi password and master password, in every reply
  (rejected forms included). Text typed into a *plain* field is the sender's own and may come back, escaped.
- **Done is done:** after save or exit no request can change the flash.
- **Reader:** same answer for any cut of the bytes (every two-piece cut, random pieces, byte by byte); every
  accepted request is within the caps (method, target ≤ 256, body ≤ 4096); chunked bodies, a second differing
  `Content-Length`, bare CR/LF, folded headers refused.
- **Reply writer:** whatever the handler asks for, the bytes are one message (CR/LF in a header or content
  type, a forged second `Content-Length` or `Transfer-Encoding`, a body containing a fake response).
- **No memory errors** under AddressSanitizer/UBSan over ~100,000 randomized requests.
- Already covered by earlier tests and re-read, not re-tested: connection flood and slot limits, slow clients,
  a client leaving mid-save, the password never being logged, AP refusing an empty password.

## Test quality (mutation check)
Planted in a scratch copy and caught by the new test: unescaped `"`, CSRF check removed, default password
accepted, a rejected form that still writes, an exit that does not clear the switch, a form that stays usable
after saving, a secret echoed into the page, confirmation field ignored, missing password accepted on a blank
board, the F1 fix reverted. One mutant survives on purpose-equivalence: dropping the length check in
`validSetupPassword` changes nothing because the settings engine enforces 8–63 independently (two layers).

## Owner decisions recorded
- **F3** (DNS rebinding): fixed (follow-up patch). Owner approved.
- **Serial prompt while armed**: not changed. The serial `BootConfigFlow` runs only before the board is armed; running it in parallel with the setup WiFi loop would need a refactor. The skip-while-armed behaviour is documented in `INSTALL.md` (the "forgotten master password" section).
- **F4** (CSRF token entropy on a real board): owner confirmed this is acceptable for setup mode; the CSRF check itself is correct and constant-time. Verify on hardware in S11.

## Running it
`./run_tests.sh --no-sketch-compile` runs `test_setup_fuzz` (≈1.5 s, fixed seed). To hunt longer, with the
sanitizers watching:

    g++ -std=c++17 -O1 -g -fsanitize=address,undefined -DFUZZ_ROUNDS=15000 -DFUZZ_SEED=0xC0FFEE777ULL \
        -I tests/cpp/ota_fakes -I Arduino/ESP32_CAM_Recorder tests/cpp/test_setup_fuzz.cpp -o /tmp/fuzz && /tmp/fuzz
