# Camera settings templates

A template is ONE line of `KEY=value;KEY=value;...` that you paste into the
Serial Monitor (115200 baud, line ending "Newline") to configure a camera in one go.

- `example.recorder.template.txt` — every setting of `ESP32_CAM_Recorder`, with placeholder values.
- Make your own: configure one camera, type `EXPORT` in its settings mode, save the line it prints.
- For the next camera, paste the template, then a second line with only what differs (`CAMERA_ID=cam2`).
- Real templates contain your Wi-Fi password and API key: name them `*.txt` (gitignored) — only `example.*` files are committed.
- Special characters in a value: write `\;`, `\:` and `\\` for a literal `;`, `:` and `\`.
