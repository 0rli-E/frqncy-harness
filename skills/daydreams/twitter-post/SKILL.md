---
name: twitter-post
description: Post tweets, search timeline, reply to threads on X (Twitter) via the scraped client used by `@daydreamsai/twitter`. Username/password auth, no developer-API account required. Use when the user mentions tweeting, posting to X, replying to a tweet, or searching X.
keywords: [twitter, tweet, x.com, post tweet, reply, thread, retweet, search twitter, timeline]
---

# Post to X (Twitter)

Mirrors `@daydreamsai/twitter`. Uses scraped username/password auth — no
X developer API account needed. The trade-off: if X changes their auth
flow or the user gets challenged, the credentials break.

## Setup

```bash
frqncy-harness auth set twitter-username
frqncy-harness auth set twitter-password
# Optional 2FA
frqncy-harness auth set twitter-2fa-secret
```

## Posting via the agent-twitter-client lib

```bash
npm install agent-twitter-client
```

```js
import { Scraper } from "agent-twitter-client";
const scraper = new Scraper();
await scraper.login(USERNAME, PASSWORD, EMAIL, TWO_FA_SECRET);

// Post
await scraper.sendTweet("hello from my agent");

// Reply
await scraper.sendTweet("@user reply text", REPLY_TO_TWEET_ID);

// Search
const tweets = await scraper.searchTweets("agent commerce", 20);

// Timeline
const home = await scraper.fetchHomeTimeline(20);
```

## Risk controls

- Never log the password / 2FA secret to the trace.
- Store cookies after first login (`scraper.getCookies()`) so subsequent
  runs don't re-trigger auth challenges.
- Throttle posts to <1/min to avoid spam classification.
- Confirm a draft with the user before posting if the tweet has @-mentions
  or financial claims.

## What you should NOT do

- Don't auto-follow accounts — high friction, easy to lose access for it.
- Don't post on behalf of the user without showing them the exact text first.
- Don't shorten links via t.co or bit.ly — full URLs are more transparent.
