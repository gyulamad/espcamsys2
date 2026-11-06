# Notifications

The relay can send you a message — a text and, where there is one, a thumbnail picture — when something
happens. Every way of delivering it is a *channel* behind one interface (`notifier.js`); the code that
raises the event never knows which channels exist. You can configure one or several; with none, nothing is
sent and nothing changes.

```
 relay event ──► Notifier interface ──► Telegram   (this file)
                                   └──► e-mail / ntfy (more channels plug in the same way)
```

## Telegram (recommended)

A Telegram bot is free, needs no server of your own, and shows the thumbnail right in the chat.

### 1. Create the bot

1. In Telegram, open a chat with **@BotFather** and send `/newbot`.
2. Pick a name and a username (it must end in `bot`).
3. BotFather answers with the **token**, like `123456789:AAH...`. Anyone who has it controls the bot:
   treat it like a password and never commit it.

### 2. Find your chat id

1. Open a chat with your new bot and press **Start** (send it any message). A bot cannot message you first.
2. On a computer you trust, open this address in a browser (put your token in):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. In the answer, find `"chat":{"id":123456789,...}`. That number is your **chat id**.
   - A **group** works too: add the bot to the group, send a message there, and read the id from
     `getUpdates` (a group's id is negative, e.g. `-1001234567890`).
   - A **channel**: make the bot an administrator and use `@yourchannelname` as the id.

### 3. Tell the relay

Either in `nodejs/camera-relay/config.js` (see `example.config.js`):

```js
notifications: {
  telegram: {
    botToken: '123456789:AAH...',
    chatId: '123456789',
  },
},
```

or, better, keep the token out of any file and give it to the relay's environment (for a systemd service:
`Environment=TELEGRAM_BOT_TOKEN=...` and `Environment=TELEGRAM_CHAT_ID=...` in the unit, or an
`EnvironmentFile=` that only root can read). The environment wins over `config.js`.

Restart the relay. Its log says `notifications: telegram` when the channel is on, or a
`[config] ...` warning saying what is wrong with the settings (the token itself is never printed).

### 4. Test it

```
curl -X POST -H "X-Control-Key: YOUR_CONTROL_KEY" http://localhost:8080/notifications/test
```

You should receive a message with a picture within a few seconds, and the answer lists every channel:
`{"results":[{"name":"telegram","ok":true}]}`. A failure says why, for example
`Telegram sendMessage was refused: Forbidden: bot was blocked by the user` (press **Start** in the chat) or
`... chat not found` (wrong chat id — did you press Start?).

### Safety notes

- The relay only ever talks to `api.telegram.org`, over HTTPS, with a 15 s timeout; no setting can point the
  token anywhere else.
- Messages are sent as plain text, so nothing in a camera or file name can turn into formatting or links
  you did not intend.
- Telegram sees the messages and pictures (they are not end-to-end encrypted). Use a private chat and do not
  send footage you would not want on a third party's server. Thumbnails only — never the clip itself.
- If the token leaks, send `/revoke` to @BotFather and put the new one in.

## Adding another channel

Write a class that extends `Notifier` and implements `deliver({ text, image })`, give the module a
`resolve...Config(raw, env)` function, and add one line to `CHANNELS` in `index.js`. The message is already
checked and cleaned when `deliver` gets it; `deliver` throws an `Error` whose message holds no secret when it
fails. Unit tests for a channel inject a fake `post`, so they need no network (see
`tests/node/test_notify_telegram.js`).
