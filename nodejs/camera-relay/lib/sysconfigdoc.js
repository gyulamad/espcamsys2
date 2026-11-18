'use strict';

// sysconfigdoc.js — SETTINGS.md, the reference of every relay setting, written from the table in lib/sysfields.js so
// the two cannot disagree (tests/node/test_sysconfig_inventory.js fails while the file is out of date).
//
//   node lib/sysconfigdoc.js > SETTINGS.md        (run from nodejs/camera-relay/)
//
// Pure: no fs. buildReference() returns the text.

const { FIELDS, BOOTSTRAP_ENV } = require('./sysfields');

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (text) => `\`${cell(text)}\``;

// What a default looks like in the table. A secret has none.
function defaultText(f) {
  if (f.type === 'secret') return '— (none)';
  if (f.default === undefined) return '—';
  if (Array.isArray(f.default)) return code(JSON.stringify(f.default));
  if (f.default === '') return '`""` (empty)';
  return code(f.default);
}

function row(f) {
  const where = f.key === 'alarmRecordSeconds' ? '— (settings.json)' : (f.config ? code(f.config.join('.')) : code(f.key));
  const notes = [f.locked ? 'locked: config.js only' : '', f.env && f.envFlag ? (f.envFlag.trueWhen !== undefined ? `env: on only for "${f.envFlag.trueWhen}"` : `env: off only for "${f.envFlag.falseWhen}"`) : ''].filter(Boolean).join('; ');
  return `| ${code(f.key)} | ${f.tier} | ${f.type} | ${defaultText(f)} | ${f.restart ? 'restart' : 'at once'} | ${f.env ? code(f.env) : '—'} | ${where} | ${cell(notes)} |`;
}

function buildReference() {
  const groups = [];
  for (const f of FIELDS) if (!groups.includes(f.group)) groups.push(f.group);
  const lines = [
    '# Relay settings reference',
    '',
    'Generated from `lib/sysfields.js` by `node lib/sysconfigdoc.js > SETTINGS.md` — do not edit by hand. A test fails while this file is out of date.',
    '',
    'Every value the relay uses is a row here. The **default** is what the relay used before the value became a setting, so an empty',
    'store and an untouched `config.js` change nothing. Where a value comes from, strongest first:',
    '',
    '1. its **environment variable**, if the row has one (the page shows such a row as read-only);',
    '2. the **settings store** (`system-settings.json`, written by `POST /system-settings`);',
    '3. **`config.js`** (the column "config.js" says where, when it is not the key\'s own name);',
    '4. the **default**.',
    '',
    '**restart** = read once at startup: a saved change counts after the relay restarts. **at once** = read each time it is used.',
    'A **locked** row is shown but cannot be changed through the API: it decides which program the relay runs, so only the owner of the machine can change it, in `config.js`.',
    '',
  ];
  for (const g of groups) {
    lines.push(`## ${g}`, '', '| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const f of FIELDS.filter((x) => x.group === g)) lines.push(row(f));
    lines.push('');
  }
  lines.push('## Environment variables that are not settings', '', '| Variable | Why it cannot be a setting |', '| --- | --- |');
  for (const [name, why] of Object.entries(BOOTSTRAP_ENV)) lines.push(`| ${code(name)} | ${cell(why)} |`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildReference };

if (require.main === module) process.stdout.write(buildReference());
