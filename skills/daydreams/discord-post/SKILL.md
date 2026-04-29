---
name: discord-post
description: Post messages to Discord channels, read recent messages, react with emoji, send DMs via a Discord bot token. Mirrors `@daydreamsai/discord`. Use when the user mentions Discord, posting to a channel, sending a DM, or a specific channel name.
keywords: [discord, discord channel, discord message, discord bot, send dm, announce]
---

# Post to Discord

Mirrors `@daydreamsai/discord`. Drives `discord.js`. The user supplies a
bot token; the bot needs to be invited to the target server.

## Setup

```bash
frqncy-harness auth set discord-token
# Optional: pin a default channel
export DISCORD_DEFAULT_CHANNEL_ID=...
```

## Posting

```js
import { Client, GatewayIntentBits, TextChannel } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
await client.login(process.env.DISCORD_TOKEN);

const channel = await client.channels.fetch(CHANNEL_ID);
await (channel as TextChannel).send("Hello from agent");

// Embed
await (channel as TextChannel).send({
  embeds: [{
    title: "Settlement summary",
    description: "Paid 0.05 USDC for /skills/weekly-update",
    color: 0x00ff00,
    timestamp: new Date().toISOString(),
  }],
});

// React
const sent = await (channel as TextChannel).send("ack?");
await sent.react("✅");

await client.destroy();
```

## Quick path: webhook (no bot needed)

If the user just wants to push messages without a full bot, suggest a
Discord webhook URL:

```bash
curl -X POST https://discord.com/api/webhooks/.../... \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello from agent"}'
```

Webhooks: simpler, channel-scoped, no permissions to manage.

## Risk controls

- Bot tokens are highly sensitive — they grant full bot access to every
  guild the bot is in. Never log to the trace.
- Confirm `client.user.id` matches the expected bot before posting.
- Rate limit to 5 messages/sec/channel max.
- For announcements, confirm with the user before sending if the channel
  has >100 members.

## What you should NOT do

- Don't bypass Discord's terms — no scraping, no impersonation, no DMs to
  users who didn't opt in.
- Don't store the token in plain config — use the harness auth store.
