---
name: genai-media
description: Generate images and video via Daydreams Router (`fal:flux-2-pro`, `fal:flux-schnell`, `fal:kling-1.5-master`, `fal:kling-2.5-pro`). Mirrors `@daydreamsai/genai`. Use when the user wants to generate, edit, or analyze images or video — agent visuals, Twitter cards, marketing illustrations, video shorts.
keywords: [image, generate image, illustration, art, picture, flux, kling, video, generate video, thumbnail, icon, banner, dalle, stable diffusion]
---

# Generate images + video via Daydreams Router

Mirrors `@daydreamsai/genai`'s `analyzeImage` / generation surface. The
harness already has Daydreams Router as a paid provider lane, so image +
video generation is a single chat call against `fal:*` or `kling:*` models.

## Available models (current)

Image:
- `fal:flux-2-pro` — high-quality, slower
- `fal:flux-2-flex` — balance of quality + cost
- `fal:flux-schnell` — fast, cheaper
- `fal:imagen-4` — Google Imagen 4 via Fal

Video:
- `fal:kling-1.5-master` — text-to-video, high quality
- `fal:kling-2.5-pro` — newer Kling
- `fal:wan-2.5` — alternative video model

Get a fresh list with:

```bash
curl https://ai.xgate.run/v1/models | jq '.data[] | select(.id | startswith("fal"))'
```

## How to invoke

The Daydreams Router image endpoint is OpenAI-compatible:

```js
import { stream } from "@frqncy-network/harness";

for await (const ev of stream({
  model: "daydreams-router/fal:flux-2-pro",
  messages: [{
    role: "user",
    content: "isometric illustration of an autonomous AI agent paying for an API call via blockchain, soft pastel palette, 1024x1024",
  }],
})) {
  if (ev.type === "text") process.stdout.write(ev.delta);
}
```

The router signs an ERC-2612 USDC permit on the user's behalf (one permit
per session, accumulating spend). Output URL or base64 image lands in the
assistant text or via the model-specific response shape.

For video, same call with a `kling:*` model:

```js
model: "daydreams-router/fal:kling-2.5-pro",
messages: [{ role: "user", content: "5-second loop of a coin minting" }],
```

## Pricing

Per-token / per-call pricing lives on each model object's `pricing` field
in `/v1/models`. Image generation is typically $0.01–0.05/image, video is
$0.10–1.00/clip. The harness's budget guardrails apply (`payments.budget`
soft warn / hard abort).

## Risk controls

- Always quote price BEFORE generating (`pay quote` doesn't apply here
  since the router is a session-permit lane, but the user can check
  `/v1/models` for per-call estimates).
- Batch user requests: if they ask for 10 variations, send 1 prompt with
  `n: 10` rather than 10 separate calls (saves session-permit overhead).
- Cache outputs locally — don't regenerate the same prompt twice.

## What you should NOT do

- Don't generate images of real public figures in compromising contexts.
  The harness's content policy (and Fal's) will reject these and you'll
  burn budget on the failed call.
- Don't auto-post generated images to Twitter/Discord without showing the
  user first.
- Don't expose the user's CDP wallet permit cap to the chat — the router's
  session is internal.
