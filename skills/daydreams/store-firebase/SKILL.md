---
name: store-firebase
description: Persist agent state in Firebase Firestore. Mirrors `@daydreamsai/firebase`. Use when the user mentions Firebase, Firestore, persistent agent memory, or syncing agent state to a Google-hosted db.
keywords: [firebase, firestore, google cloud, persistent state]
---

# Persist via Firebase Firestore

Mirrors `@daydreamsai/firebase`. The harness's trace store is local JSONL
+ optional GitHub mirror by default; for hosted persistent agent state
across devices, Firestore is the cleanest path.

## Setup

```bash
# Service-account JSON for server-side write access
frqncy-harness auth set firebase-service-account-json
export GOOGLE_APPLICATION_CREDENTIALS=$HOME/.frqncy-harness/firebase-sa.json

npm install firebase-admin
```

## Writing

```js
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

await db.collection("frqncy-agent-state")
  .doc(conversationId)
  .set({
    lastTurn: messages[messages.length - 1].content,
    paidThisSession: budget.spentAtomic.toString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
```

## Reading

```js
const snap = await db.collection("frqncy-agent-state").doc(conversationId).get();
if (snap.exists) console.log(snap.data());
```

## What you should NOT do

- Don't store private keys, CDP secrets, or signatures in Firestore.
- Don't bypass security rules — Firestore lets you set per-document ACLs;
  configure them so the agent's project key can only read/write its own
  collection.
