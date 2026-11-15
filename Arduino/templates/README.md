# Camera settings templates

A template is ONE line of `KEY=value;KEY=value;...` that you paste into the
Serial Monitor (115200 baud, line ending "Newline") to configure a camera in one go.

- `example.recorder.template.txt` — every setting of `ESP32_CAM_Recorder`, with placeholder values.
- `example.person.template.txt` — every setting of `ESP32_CAM_TFLite_Person`.
- `setup_credentials.example.h` — not a settings line: an optional **build-time** default master password for the setup WiFi
  (F-21). Copy it to `Arduino/<sketch>/setup_credentials.local.h` (gitignored) and edit it; the sketches use it if it is there.
- Make your own: configure one camera, type `EXPORT` in its settings mode, save the line it prints.
- For the next camera, paste the template, then a second line with only what differs (`CAMERA_ID=cam2`).
- Real templates contain your Wi-Fi password and API key: name them `*.txt` (gitignored) — only `example.*` files are committed.
- Special characters in a value: write `\;`, `\:` and `\\` for a literal `;`, `:` and `\`.
- No cable? The same settings can be typed into the board's own setup WiFi page instead (a form, not a line): see
  "First setup without a cable" in `SETUP.md`. A template line is for the serial console only.
- `EXPORT` also prints `SETUP_PASSWORD` (the master password of the setup WiFi) once a board has its own, unmasked. A line
  that contains it is as secret as the API key: keep it in a `*.txt` file (gitignored), never in an `example.*` file.
