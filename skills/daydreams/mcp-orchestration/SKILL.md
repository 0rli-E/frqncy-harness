---
name: mcp-orchestration
description: Connect to and orchestrate MCP servers (stdio + HTTP + SSE) — list tools, call them, manage the registry. Use when the user mentions MCP, model context protocol, an MCP server name, or wants to add / remove / inspect an MCP integration.
keywords: [mcp, model context protocol, mcp server, claude desktop, stdio, sse, streamable http]
---

# MCP orchestration

The harness ships first-class MCP support. `~/.frqncy-harness/mcp.json` is
Claude Desktop schema-compatible plus a `_harness` namespace for
extensions. As of v0.13.5 transports include `stdio`, `streamable-http`,
and `sse`. When `--payments` is on, HTTP/SSE transports auto-pay 402'd MCP
servers under the same wallet + budget + hook plumbing as the rest of the
harness.

## CLI

```bash
frqncy-harness mcp list
frqncy-harness mcp add <name> <command> [args...]      # stdio
frqncy-harness mcp add <name> --url https://...        # streamable-http
frqncy-harness mcp add <name> --url https://... --transport sse
frqncy-harness mcp enable <name>
frqncy-harness mcp disable <name>
frqncy-harness mcp test <name>                          # probe + list tools
frqncy-harness mcp import-from-claude-desktop          # pull from Claude.app config
```

## Agent-mode usage

```bash
frqncy-harness agent "use the github MCP to find the latest Daydreams release" --payments
```

The agent loop auto-loads enabled MCP servers, namespaces their tools
(`<server-name>__<tool-name>`), and threads the wrapped fetch into HTTP
transports.

## Authoring an MCP server

The harness can BE the server too: `frqncy-harness serve` exposes paid
skill routes which are MCP-adjacent (HTTP + JSON). For a real MCP server,
use `@modelcontextprotocol/sdk`'s `Server` class and stdio transport, then
register it in your local `mcp.json`.

## What you should NOT do

- Don't enable an MCP server you haven't audited — they get full tool-call
  authority once registered.
- Don't expose secrets via env vars to MCP subprocesses unless you've
  reviewed the server's source.
