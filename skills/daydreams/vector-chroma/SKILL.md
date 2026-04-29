---
name: vector-chroma
description: Vector embeddings + similarity search via Chroma. Mirrors `@daydreamsai/chroma`. Use when the user wants to embed documents, run semantic search over a corpus, build a RAG store, or chunk/index trace history.
keywords: [chroma, chromadb, vector, embedding, similarity search, semantic search, rag, retrieval]
---

# Vector store via Chroma

Mirrors `@daydreamsai/chroma`. The harness's traces are append-only JSONL
— if you want to query them by similarity, embed and index in Chroma.

## Setup

```bash
# Local Chroma server (Docker)
docker run -p 8000:8000 chromadb/chroma

# Or use Chroma Cloud (signup at chroma.com)
export CHROMA_API_URL=https://...
export CHROMA_API_KEY=...
```

## Indexing a corpus

```bash
npm install chromadb
```

```js
import { ChromaClient } from "chromadb";
const client = new ChromaClient({ path: "http://localhost:8000" });
const collection = await client.getOrCreateCollection({ name: "frqncy-traces" });

await collection.add({
  ids: ["trace-1", "trace-2"],
  documents: ["agent paid 0.05 USDC for /skills/weekly-update", "..."],
  metadatas: [{ ts: "2026-04-30", thread: "ops" }, ...],
});

// Query
const result = await collection.query({
  queryTexts: ["how much did i spend on premium endpoints last week?"],
  nResults: 5,
});
```

## Pairing with the harness

Use Chroma to index:
- `payment` trace records (for "find similar settlements")
- `skill` outputs (for "find prior runs of this skill")
- The harness's never-compacted JSONL trace files (read all of `~/.frqncy-harness/traces/<date>/*.jsonl`, embed each record)

## What you should NOT do

- Don't store wallet keys, signatures, or facilitator JWTs in Chroma
  documents — embeddings are not encryption.
- Don't re-embed the entire trace history on every run — keep a watermark.
