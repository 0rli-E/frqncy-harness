---
name: telegram-post
description: Post messages to Telegram chats / channels, reply to messages, send media via a Telegram bot token. Mirrors `@daydreamsai/telegram`. Use when the user mentions Telegram, a Telegram chat, channel, or bot.
keywords: [telegram, telegram chat, telegram channel, telegram bot, tg]
---

# Post to Telegram

Mirrors `@daydreamsai/telegram`. Drives `telegraf`. The user creates a bot
via @BotFather, gets a token, and the bot needs to be added to target
chats/channels.

## Setup

```bash
frqncy-harness auth set telegram-token
# Optional: pin a default chat id
export TELEGRAM_DEFAULT_CHAT_ID=-100...
```

## Posting

```bash
npm install telegraf
```

```js
import { Telegraf } from "telegraf";
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// Plain message
await bot.telegram.sendMessage(CHAT_ID, "Hello from agent");

// Markdown
await bot.telegram.sendMessage(CHAT_ID, "*bold* and _italic_", {
  parse_mode: "MarkdownV2",
});

// Image
await bot.telegram.sendPhoto(CHAT_ID, { url: "https://example.com/img.png" }, {
  caption: "settlement diagram",
});
```

## Quick path: bot HTTP API directly

For one-off pushes, hit the API directly — no SDK needed:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}&text=hello"
```

## Finding chat IDs

Channels: `@channelname` works in `chat_id`.
Groups: numeric, prefix `-100` for supergroups (e.g. `-1001234567890`).
DMs: numeric user id (the user has to start a chat with the bot first).

To discover a chat id, send a message to the bot and call `getUpdates`:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates"
# Look for chat.id in the response
```

## Risk controls

- Bot tokens are sensitive but have limited blast radius (only chats the
  bot is added to).
- Telegram rate limit: ~30 messages/sec across all chats. If the agent
  needs higher throughput, batch into one message.
- For broadcasts to channels with >1000 subscribers, confirm with the user
  before sending.

## What you should NOT do

- Don't use the bot to send unsolicited DMs — Telegram bans bots that do.
- Don't mass-add users to a group via the bot — same.
- Don't expose the token in error messages or logs.
