---
name: synthetic-training
description: Capture agent reasoning + tool calls into structured datasets for fine-tuning. Mirrors `@daydreamsai/synthetic`. Use when the user mentions training data, fine-tuning, distillation, capturing reasoning, or building a custom model from agent traces.
keywords: [synthetic, training data, fine-tuning, distillation, dataset, reasoning capture, sft, rlhf]
---

# Synthetic training-data capture

Mirrors `@daydreamsai/synthetic`. The harness already writes never-
compacted JSONL traces of every conversation — that IS the training
substrate. This skill orients the LLM toward the right tools to:

1. Filter traces by quality (use `frqncy-harness reflect` + `codify`)
2. Extract (prompt, completion) pairs into a dataset
3. Convert into the format the user's training infra expects (HuggingFace
   datasets, OpenAI fine-tune JSONL, Anthropic dataset format)

## Filter to high-quality traces

```bash
# Reflect across recent traces — produces a markdown proposal of failure modes
frqncy-harness reflect --last 100

# Codify a specific successful conversation into a regression test
frqncy-harness codify <conv-id>
```

`reflect` is the macro filter — it ranks traces by recurring patterns.
`codify` is the micro filter — pick a known-good trace and pin it.

## Extract pairs

```bash
# Dump all assistant turns from a conversation
cat ~/.frqncy-harness/traces/2026-04-30/<conv>.jsonl \
  | jq 'select(.type == "user" or .type == "assistant") | {role: .role, content: .content}'
```

Pair user → assistant turns into your dataset format:

```js
import { promises as fs } from "node:fs";
import path from "node:path";

const DAY = "2026-04-30";
const dir = `${process.env.HOME}/.frqncy-harness/traces/${DAY}`;
const files = await fs.readdir(dir);
const dataset = [];
for (const f of files) {
  const lines = (await fs.readFile(path.join(dir, f), "utf-8")).split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l));
  // Pair user → assistant
  for (let i = 0; i < records.length - 1; i++) {
    if (records[i].type === "user" && records[i + 1].type === "assistant") {
      dataset.push({ prompt: records[i].content, completion: records[i + 1].content });
    }
  }
}
await fs.writeFile("dataset.jsonl", dataset.map((d) => JSON.stringify(d)).join("\n"));
```

## Output formats

- **OpenAI fine-tune**: `{messages: [{role, content}, ...]}` per line
- **Anthropic**: `{prompt: "Human: …\n\nAssistant:", completion: " …"}` per line
- **HuggingFace**: any JSONL the user's tokenizer config expects

## What you should NOT do

- Don't include `payment` records, signatures, or wallet metadata in the
  training set — embeddings/models will memorize secrets.
- Don't use the user's traces as a public dataset without their explicit
  written consent.
- Don't fine-tune a model that learns to bypass the lethal-trifecta gate
  or pre-payment hooks.
