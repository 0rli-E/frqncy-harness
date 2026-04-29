---
name: store-supabase
description: Persist agent state in Supabase Postgres. Mirrors `@daydreamsai/supabase`. Use when the user mentions Supabase, Postgres, relational persistent state, row-level security, or wants SQL queries over agent history.
keywords: [supabase, postgres, postgresql, sql, row level security, persistent state]
---

# Persist via Supabase

Mirrors `@daydreamsai/supabase`. Use when the user wants relational queries
over agent state.

## Setup

```bash
frqncy-harness auth set supabase-url
frqncy-harness auth set supabase-service-role-key  # server-side only
npm install @supabase/supabase-js
```

## Schema

```sql
create table agent_state (
  conversation_id uuid primary key,
  thread text,
  last_turn text,
  paid_atomic numeric default 0,
  history jsonb default '[]'::jsonb,
  updated_at timestamptz default now()
);

create index on agent_state (thread, updated_at desc);
```

## Writing + querying

```js
import { createClient } from "@supabase/supabase-js";
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Upsert
await sb.from("agent_state")
  .upsert({
    conversation_id: conversationId,
    thread: "ops",
    last_turn: msg,
    paid_atomic: budget.spentAtomic.toString(),
  });

// Query
const { data } = await sb.from("agent_state")
  .select("*")
  .eq("thread", "ops")
  .order("updated_at", { ascending: false })
  .limit(20);
```

## What you should NOT do

- Don't expose the service-role key to the client / browser — it bypasses
  RLS. Use the anon key with explicit RLS policies for client access.
- Don't store wallet secrets in `history` jsonb.
