---
name: store-mongo
description: Persist agent state in MongoDB Atlas or self-hosted Mongo. Mirrors `@daydreamsai/mongo`. Use when the user mentions Mongo, MongoDB, NoSQL persistent state, or syncing agent memory across devices.
keywords: [mongo, mongodb, atlas, nosql, persistent state]
---

# Persist via MongoDB

Mirrors `@daydreamsai/mongo`. Use Atlas for hosted, or self-host for full
control.

## Setup

```bash
frqncy-harness auth set mongo-uri
# mongodb+srv://user:pass@cluster.mongodb.net/dbname
npm install mongodb
```

## Writing

```js
import { MongoClient } from "mongodb";
const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const col = client.db("frqncy").collection("agent-state");

await col.updateOne(
  { conversationId },
  {
    $set: {
      lastTurn: messages[messages.length - 1].content,
      paidThisSession: budget.spentAtomic.toString(),
      updatedAt: new Date(),
    },
    $push: { history: { ts: new Date(), event: "settlement", txHash: "0x..." } },
  },
  { upsert: true },
);

await client.close();
```

## Reading + querying

```js
// Latest 10 settlements across all sessions
const recent = await col
  .aggregate([
    { $unwind: "$history" },
    { $match: { "history.event": "settlement" } },
    { $sort: { "history.ts": -1 } },
    { $limit: 10 },
  ])
  .toArray();
```

## What you should NOT do

- Don't store wallet secrets or session permits in Mongo.
- Don't run analytics queries against the production cluster — replicate
  to a read-only secondary.
