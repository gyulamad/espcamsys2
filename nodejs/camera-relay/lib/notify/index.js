'use strict';

// index.js — builds the notifier the relay uses from config.js's `notifications` block: one strategy per
// configured channel, gathered in a MultiNotifier. Adding a channel = one entry in CHANNELS; nothing else
// in the relay changes.
//
//   createNotifier(rawConfig, env, { post }) -> { notifier: MultiNotifier, warnings: string[] }

const { MultiNotifier } = require('./notifier');
const { TelegramNotifier, resolveTelegramConfig } = require('./telegram');

// name -> { resolve(rawBlock, env) -> { config, warnings }, create({ config, post }) -> Notifier }
const CHANNELS = {
  telegram: { resolve: resolveTelegramConfig, create: (deps) => new TelegramNotifier(deps) },
};

function createNotifier(raw, env, { post }) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const notifiers = [];
  const warnings = [];
  for (const [name, channel] of Object.entries(CHANNELS)) {
    const resolved = channel.resolve(given[name], env);
    warnings.push(...resolved.warnings);
    if (resolved.config) notifiers.push(channel.create({ config: resolved.config, post }));
  }
  return { notifier: new MultiNotifier(notifiers), warnings };
}

module.exports = { createNotifier, CHANNELS };
