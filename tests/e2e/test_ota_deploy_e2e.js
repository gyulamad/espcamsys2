#!/usr/bin/env node
'use strict';
// test_ota_deploy_e2e.js — end-to-end check of ota-deploy.sh against a REAL relay process,
// with a fake `arduino-cli` (there is no ESP32 toolchain on a test machine) in a throwaway git
// repository. What it proves about the script:
//   - the version is the git revision; a dirty tree gets ".t<epoch>" and a warning
//   - fw_version.h with FW_GIT is written before each compile and removed afterwards
//   - the right binary of each sketch is published to the right /ota/<type>, with the
//     control key, and the relay really serves exactly those bytes
//   - a build that fails, a build that does not fit the app slot, or a refused upload
//     stops the run with a non-zero exit — and `all` publishes NOTHING unless every sketch built
//   - --wait: exits 0 once every device of the deployed type reports the new version, and
//     non-zero (with the table and the device's last error) when one does not
// Core modules only. Own ports. Needs bash, git and curl (the script's own requirements).
//
// Usage:  node tests/e2e/test_ota_deploy_e2e.js     Exit code: 0 if every check passed, 1 otherwise.

const fs = require('fs');
const nodeHttp = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '../..');
const RELAY_DIR = path.join(REPO, 'nodejs/camera-relay');
const CONFIG_PATH = path.join(RELAY_DIR, 'config.js');
const PORT = Number(process.env.E2E_OTADEP_PORT || 19350);
const PUSH_PORT = Number(process.env.E2E_OTADEP_PUSH_PORT || 19351);
const KEY = 'e2e-otadep-key';
const CONTROL = 'e2e-otadep-control';

let passCount = 0;
let failCount = 0;
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('[FAIL] the test ended without finishing (no summary was reached)'); process.exitCode = 1; }
});
function check(name, cond, detail) {
  if (cond) { passCount += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.error(`[FAIL] ${name}${detail ? ' -- ' + detail : ''}`); }
}
function summarize() {
  finished = true;
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const tool of ['bash', 'git', 'curl']) {
  if (spawnSync(tool, ['--version']).error) {
    console.log(`SKIP: ${tool} not found on PATH`);
    finished = true;
    process.exit(0);
  }
}

let createdTempConfig = false;
function startRelay(env) {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "module.exports = { port: 8080, pushPort: 8081, camKey: 'placeholder' };\n");
    createdTempConfig = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: RELAY_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), PUSH_PORT: String(PUSH_PORT), CAM_KEY: KEY, CONTROL_KEY: CONTROL }, env),
    });
    let out = '';
    let settled = false;
    const onData = (d) => {
      out += d.toString();
      if (!settled && out.includes(`raw push) listening on :${PUSH_PORT}`)) { settled = true; resolve({ child }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`relay exited early (code ${code}):\n${out}`)); } });
    setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`relay not ready in 5s:\n${out}`)); } }, 5000).unref();
  });
}
function stopRelay(relay) {
  return new Promise((resolve) => {
    const child = relay && relay.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* dead */ } resolve(); }, 2000);
  });
}

function request(method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}
const camGet = (p) => request('GET', p, { 'X-Api-Key': KEY });

// The fake toolchain: writes <output-dir>/<Sketch>.ino.bin (an "app image": first byte 0xE9) and
// notes what fw_version.h said at compile time, so the test can see what the build was told.
const FAKE_ARDUINO_CLI = `#!/usr/bin/env bash
# fake arduino-cli for test_ota_deploy_e2e.js
out=""; sketch=""; fqbn=""
while [ $# -gt 0 ]; do
  case "$1" in
    compile) shift ;;
    --fqbn) fqbn="$2"; shift 2 ;;
    --output-dir) out="$2"; shift 2 ;;
    --build-property) shift 2 ;;
    *) sketch="$1"; shift ;;
  esac
done
name="$(basename "$sketch")"
echo "compile $name fqbn=$fqbn fw_version=$(cat "$sketch/fw_version.h" 2>/dev/null | tr -d '\\n')" >> "$FAKE_LOG"
case "$name" in *Recorder*) kind=recorder ;; *) kind=detector ;; esac
if [ "$FAKE_COMPILE_FAIL" = "$kind" ]; then echo "error: fake compile failure" >&2; exit 1; fi
size="$FAKE_BIN_SIZE"
[ "$kind" = detector ] && [ -n "$FAKE_BIN_SIZE_DETECTOR" ] && size="$FAKE_BIN_SIZE_DETECTOR"
mkdir -p "$out"
# 0xE9, then bytes that differ per sketch and per build, so a mixed-up upload is noticed
head -c "$size" /dev/zero | tr '\\0' "$(printf "\\\\$(printf %o $(( 65 + \${#name} )))")" > "$out/$name.ino.bin"
printf '\\351' | dd of="$out/$name.ino.bin" bs=1 count=1 conv=notrunc 2>/dev/null
`;

function runDeploy(ctx, args, extraEnv) {
  const r = spawnSync('bash', [path.join(ctx.repo, 'ota-deploy.sh'), ...args], {
    cwd: ctx.repo,
    env: Object.assign({}, process.env, {
      PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`,
      OTA_CONF: ctx.conf, FAKE_LOG: ctx.fakeLog, FAKE_BIN_SIZE: '300000', OTA_POLL_SECONDS: '1',
    }, extraEnv || {}),
    encoding: 'utf8',
    timeout: 60000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Same, but without blocking this process: the --wait scenarios need the simulated cameras
// (below) to keep polling the relay while the script waits.
function runDeployAsync(ctx, args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(ctx.repo, 'ota-deploy.sh'), ...args], {
      cwd: ctx.repo,
      env: Object.assign({}, process.env, {
        PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`,
        OTA_CONF: ctx.conf, FAKE_LOG: ctx.fakeLog, FAKE_BIN_SIZE: '300000', OTA_POLL_SECONDS: '1',
      }, extraEnv || {}),
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function makeRepo(tmp) {
  const repo = path.join(tmp, 'repo');
  const bin = path.join(tmp, 'bin');
  for (const d of ['Arduino/ESP32_CAM_Recorder', 'Arduino/ESP32_CAM_TFLite_Person']) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
    fs.writeFileSync(path.join(repo, d, path.basename(d) + '.ino'), '// sketch\n');
  }
  fs.copyFileSync(path.join(REPO, 'ota-deploy.sh'), path.join(repo, 'ota-deploy.sh'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'fw_version.h\n');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'arduino-cli'), FAKE_ARDUINO_CLI, { mode: 0o755 });
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one');
  const conf = path.join(tmp, 'ota.conf');
  fs.writeFileSync(conf, `RELAY_URL="http://127.0.0.1:${PORT}"\nCONTROL_KEY="${CONTROL}"\n`);
  const fakeLog = path.join(tmp, 'fake.log');
  return { repo, bin, conf, fakeLog, git, sha: git('rev-parse', '--short', 'HEAD').stdout.trim(), describe: git('describe', '--always', '--dirty').stdout.trim() };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-otadep-'));
  const env = { FIRMWARE_DIR: path.join(tmp, 'firmware'), LOG_FILE: path.join(tmp, 'camera.log'), SETTINGS_FILE: path.join(tmp, 'settings.json'), SWITCH_FILE: path.join(tmp, 'switch.json') };
  let relay = null;
  try {
    relay = await startRelay(env);
    const ctx = makeRepo(tmp);
    const sketchHeader = (t) => path.join(ctx.repo, 'Arduino', t === 'recorder' ? 'ESP32_CAM_Recorder' : 'ESP32_CAM_TFLite_Person', 'fw_version.h');

    // ── usage ──
    const help = runDeploy(ctx, ['--help']);
    check('--help prints the usage and succeeds', help.code === 0 && /ota-deploy.sh \[recorder\|detector\|all\]/.test(help.out), help.out);
    check('an unknown argument is a usage error (2)', runDeploy(ctx, ['frobnicate']).code === 2);
    check('--wait without a number is a usage error (2)', runDeploy(ctx, ['all', '--wait']).code === 2);
    check('--wait with a non-number is a usage error (2)', runDeploy(ctx, ['all', '--wait', 'soon']).code === 2);
    const noConf = runDeploy(Object.assign({}, ctx, { conf: path.join(tmp, 'missing.conf') }), ['all']);
    check('without ota.conf it says so (2)', noConf.code === 2 && /ota.conf/.test(noConf.out), noConf.out);

    // ── a clean tree: version is the git revision, both sketches are built and published ──
    const clean = ctx.describe;
    check('(setup) the test repo is clean', !/dirty/.test(clean), clean);
    const r1 = runDeploy(ctx, ['all']);
    check('deploying all succeeds', r1.code === 0, r1.out);
    check('the version printed is the git revision', r1.out.includes(`Version: ${ctx.sha}`), r1.out);
    check('a clean tree gives no dev-build warning', !/WARNING/.test(r1.out), r1.out);
    const fakeLog = fs.readFileSync(ctx.fakeLog, 'utf8');
    check('each sketch was compiled with FW_GIT set to that revision',
      fakeLog.includes(`compile ESP32_CAM_Recorder fqbn=esp32:esp32:esp32cam:PartitionScheme=min_spiffs fw_version=#define FW_GIT "${ctx.sha}"`) &&
      fakeLog.includes(`compile ESP32_CAM_TFLite_Person fqbn=esp32:esp32:esp32cam:PartitionScheme=min_spiffs fw_version=#define FW_GIT "${ctx.sha}"`), fakeLog);
    check('fw_version.h is removed afterwards (it must never be committed)', !fs.existsSync(sketchHeader('recorder')) && !fs.existsSync(sketchHeader('detector')));
    check('the size line is printed', /recorder: 300000 bytes of 1966080/.test(r1.out), r1.out);
    const recVer = await camGet('/ota/recorder/version?id=c&fw=x');
    const detVer = await camGet('/ota/detector/version?id=c&fw=x');
    check('the relay now publishes the recorder at that version', recVer.status === 200 && recVer.text.startsWith(`${ctx.sha}\n`), recVer.text);
    check('...and the detector', detVer.status === 200 && detVer.text.startsWith(`${ctx.sha}\n`), detVer.text);
    const recDl = await camGet('/ota/recorder/firmware.bin?id=c');
    const detDl = await camGet('/ota/detector/firmware.bin?id=c');
    check('the recorder download is the recorder binary (0xE9 first, its own fill byte)', recDl.buf.length === 300000 && recDl.buf[0] === 0xE9 && recDl.buf[1] === 65 + 'ESP32_CAM_Recorder'.length);
    check('the detector download is the detector binary, not the recorder one', detDl.buf.length === 300000 && detDl.buf[0] === 0xE9 && detDl.buf[1] === 65 + 'ESP32_CAM_TFLite_Person'.length);

    // ── one type only ──
    fs.writeFileSync(ctx.fakeLog, '');
    const r2 = runDeploy(ctx, ['recorder']);
    const log2 = fs.readFileSync(ctx.fakeLog, 'utf8');
    check('"recorder" builds only the recorder', r2.code === 0 && /ESP32_CAM_Recorder/.test(log2) && !/TFLite/.test(log2), log2 + r2.out);

    // ── a dirty tree is a dev build ──
    fs.writeFileSync(path.join(ctx.repo, 'Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino'), '// edited\n');
    const r3 = runDeploy(ctx, ['recorder']);
    const m = /Version: (\S+)/.exec(r3.out);
    check('a dirty tree is deployed with a .t<epoch> suffix and a warning', r3.code === 0 && m && /-dirty\.t\d{9,}$/.test(m[1]) && /WARNING: uncommitted changes/.test(r3.out), r3.out);
    const dirtyVer = (await camGet('/ota/recorder/version?id=c&fw=x')).text.split('\n')[0];
    check('...and the relay got exactly that version (no "+" or other trouble)', m && dirtyVer === m[1], dirtyVer);
    ctx.git('checkout', '--', '.');

    // ── failures stop the run, and `all` is all-or-nothing ──
    const before = (await camGet('/ota/detector/version?id=c&fw=x')).text;
    fs.writeFileSync(path.join(ctx.repo, 'Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino'), '// second\n');
    ctx.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'two');
    const r4 = runDeploy(ctx, ['all'], { FAKE_COMPILE_FAIL: 'detector' });
    check('a failing compile is a non-zero exit with a clear message', r4.code === 1 && /compiling the detector sketch failed/.test(r4.out), r4.out);
    check('...and nothing was published, not even the sketch that did compile', (await camGet('/ota/detector/version?id=c&fw=x')).text === before && !(await camGet('/ota/recorder/version?id=c&fw=x')).text.startsWith(ctx.git('rev-parse', '--short', 'HEAD').stdout.trim()));
    check('...and fw_version.h is still cleaned up', !fs.existsSync(sketchHeader('recorder')) && !fs.existsSync(sketchHeader('detector')));
    const r5 = runDeploy(ctx, ['detector'], { FAKE_BIN_SIZE_DETECTOR: '2000000' });
    check('a build bigger than the app slot is refused before upload', r5.code === 1 && /does not fit an app slot/.test(r5.out), r5.out);
    const r6 = runDeploy(ctx, ['detector'], { FAKE_BIN_SIZE_DETECTOR: '50000' });
    check('an image the relay refuses (too small) fails the run and shows the relay\'s reason', r6.code === 1 && /too small/.test(r6.out), r6.out);
    fs.writeFileSync(ctx.conf, `RELAY_URL="http://127.0.0.1:${PORT}"\nCONTROL_KEY="wrong"\n`);
    const r7 = runDeploy(ctx, ['recorder']);
    check('a wrong control key fails the run (401 shown)', r7.code === 1 && /HTTP 401/.test(r7.out), r7.out);
    check('...and the control key is never printed, by a good run or a bad one', !r1.out.includes(CONTROL) && !r7.out.includes(CONTROL) && !r7.out.includes('"wrong"'));
    fs.writeFileSync(ctx.conf, `RELAY_URL="http://127.0.0.1:1"\nCONTROL_KEY="${CONTROL}"\n`);
    const r8 = runDeploy(ctx, ['recorder']);
    check('an unreachable relay fails the run', r8.code === 1 && /could not reach the relay/.test(r8.out), r8.out);
    fs.writeFileSync(ctx.conf, `RELAY_URL="http://127.0.0.1:${PORT}"\nCONTROL_KEY="${CONTROL}"\n`);

    // ── --wait: the cameras update (simulated) or do not ──
    await stopRelay(relay);
    relay = await startRelay(env);   // a fresh device table: only the simulated cameras below are in it
    const sha2 = ctx.git('rev-parse', '--short', 'HEAD').stdout.trim();
    // cam1 and cam2 are recorders still on the old version; the "cameras" poll like real ones would
    await camGet(`/ota/recorder/version?id=cam1&fw=${ctx.sha}`);
    await camGet(`/ota/recorder/version?id=cam2&fw=${ctx.sha}`);
    let stopCams = false;
    const cams = (async () => {   // after a moment both flash and report the new version
      await sleep(2500);
      while (!stopCams) {
        await camGet(`/ota/recorder/version?id=cam1&fw=${sha2}`);
        await camGet(`/ota/recorder/version?id=cam2&fw=${sha2}`);
        await sleep(500);
      }
    })();
    const r9 = await runDeployAsync(ctx, ['recorder', '--wait', '30']);
    stopCams = true;
    await cams;
    check('--wait returns success once every recorder reports the new version', r9.code === 0 && /All devices run /.test(r9.out), r9.out);
    check('...and prints a table with the devices', /cam1\s+recorder\s+\S+\s+\S+\s+updated/.test(r9.out) && /cam2\s+recorder/.test(r9.out), r9.out);

    // a camera that never updates: cam3 is stuck and reports why
    fs.writeFileSync(path.join(ctx.repo, 'Arduino/ESP32_CAM_Recorder/ESP32_CAM_Recorder.ino'), '// third\n');
    ctx.git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'three');
    const sha3 = ctx.git('rev-parse', '--short', 'HEAD').stdout.trim();
    await camGet(`/ota/recorder/version?id=cam3&fw=${sha2}&err=md5_failed`);
    const t0 = Date.now();
    const r10 = await runDeployAsync(ctx, ['recorder', '--wait', '3']);
    check('--wait times out with a non-zero exit when a camera does not update', r10.code === 1, r10.out);
    check('...within about the time asked for', Date.now() - t0 < 15000, `${Date.now() - t0} ms`);
    check('...showing the stuck camera, what it still runs, and why it failed', /cam3\s+recorder\s+\S+\s+\S+\s+pending\s+\S+\s+md5_failed/.test(r10.out) && /NOT every device runs/.test(r10.out), r10.out);
    check('...and the target in the table is the version just deployed', r10.out.includes(sha3), r10.out);

    // a type nobody has polled for: waiting must not claim success
    await stopRelay(relay);
    relay = await startRelay(env);   // the relay forgets which devices it has seen
    const r11 = await runDeployAsync(ctx, ['recorder', '--wait', '2']);
    check('with no device known to the relay, --wait does not report success', r11.code === 1 && /No device of type/.test(r11.out), r11.out);
  } catch (err) {
    check('test run completed without an unexpected error', false, err.stack || err.message);
  } finally {
    await stopRelay(relay);
    if (createdTempConfig) { try { fs.unlinkSync(CONFIG_PATH); } catch (e) { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
    summarize();
  }
}

main();
