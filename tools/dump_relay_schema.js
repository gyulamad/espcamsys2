'use strict';

// dump_relay_schema.js — prints the relay's settings as the same flat rows the firmware tables give the settings
// reference (tools/gen_settings_reference.sh): [{ key, label, default, tier, apply, category }, ...] as JSON.
//
// This file is the ONE place that knows where the relay's settings table lives and how its fields map to those
// columns. Today the table is FIELDS in nodejs/camera-relay/lib/sysconfig.js.
//
// TODO(T6a): T6a moves ALL the relay's values (about 38; the ones that today exist only in config.js or only in the
//   environment too) into the settings store. When it lands, point this adapter at the new table and drop the
//   mapping below that no longer fits; the reference then grows by itself, and nothing else in the generator changes.
// TODO(T6a): the relay table has no tier yet (the firmware's Basic / Advanced / Expert). Until it does, `tier` is null
//   and the reference shows "—". If T6a adds one, map it here.
//
// Pure mapping (relayRows) + a tiny main, so tests/node/test_settings_reference.js can run it without the file system.

const path = require('path');

// One relay field -> one reference row.
//   default  a secret is never given a default (the table has none for camKey / controlKey; this keeps it that way
//            whatever is added later); a field with no default stays null.
//   apply    `restart: true` (read once at startup, the relay must restart) is the relay's "reboot"; the firmware
//            vocabulary (live | reboot) is kept so the three tables read the same.
//   category the field's `group` (the section of the relay's settings page).
function relayRows(fields) {
  return fields.map((f) => ({
    key: f.key,
    label: f.label === undefined ? null : f.label,
    default: f.type === 'secret' || f.default === undefined ? null : f.default,
    tier: null,
    apply: f.restart ? 'reboot' : 'live',
    category: f.group === undefined ? null : f.group,
  }));
}

if (require.main === module) {
  const { FIELDS } = require(path.join(__dirname, '..', 'nodejs', 'camera-relay', 'lib', 'sysconfig'));
  process.stdout.write(JSON.stringify(relayRows(FIELDS), null, 2) + '\n');
}

module.exports = { relayRows };
