<div align="center">
  <h1>@cyanheads/guardian-mcp-server</h1>
  <p><b>Search, browse, and retrieve full article text from The Guardian's journalism archive (1999–present) via MCP. STDIO or Streamable HTTP.</b>
  <div>3 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/guardian-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-%5E2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/guardian-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/guardian-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-%5E7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/guardian-mcp-server/releases/latest/download/guardian-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=guardian-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ3VhcmRpYW4tbWNwLXNlcnZlciJdLCJlbnYiOnsiTUNQX1RSQU5TUE9SVF9UWVBFIjoic3RkaW8iLCJHVUFSRElBTl9BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22guardian-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fguardian-mcp-server%22%5D%2C%22env%22%3A%7B%22MCP_TRANSPORT_TYPE%22%3A%22stdio%22%2C%22GUARDIAN_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Prerequisites

> **A free Guardian Open Platform API key is required.** Register at [https://open-platform.theguardian.com/access](https://open-platform.theguardian.com/access) — the non-commercial developer tier is free. Set it as `GUARDIAN_API_KEY` in your MCP client config or `.env` file. The server will not start without it.
>
> **Rate limits (free tier):** 5,000 requests/day, 12 calls/second. The server applies no additional throttling — stay within these bounds.

---

## Tools

Three tools for working with The Guardian's journalism archive:

| Tool | Description |
|:-----|:------------|
| `guardian_search` | Full-text search across The Guardian's archive (1999–present) with optional section, tag, contributor, and date filters. Returns articles with full body text (HTML stripped, truncated at 2,000 words). |
| `guardian_get_article` | Fetch a single Guardian article by its ID (path slug) with full body text and all metadata. Use after `guardian_search` to retrieve the complete untruncated text. |
| `guardian_browse` | Browse The Guardian's content by section or tag, or discover available sections and tags. Four modes: `section_latest`, `tag_latest`, `list_sections`, `list_tags`. |

### `guardian_search`

Full-text search with structured filters across the entire Guardian archive.

- Supports AND, OR, NOT boolean operators and exact phrases in double quotes
- Filters: section ID, tag ID, contributor profile ID, date range (`from_date`, `to_date`)
- Returns body text (HTML stripped) truncated at 2,000 words with a truncation flag — use `guardian_get_article` for complete text
- Sort by `relevance` (default), `newest`, or `oldest`
- Pagination via `page` + `page_size` (1–50 per page)

---

### `guardian_get_article`

Fetch one article by its Guardian path-slug ID.

- Input: `article_id` from `guardian_search` results — the `id` field, e.g. `"world/2024/mar/01/ukraine-war-latest"`
- Returns complete untruncated body text (HTML stripped), full metadata, contributor list, and pillar/section classification
- `truncated: true` in the response means the body still exceeded 2,000 words after fetching

---

### `guardian_browse`

Browse and discover Guardian content — four modes in one tool.

- `section_latest`: newest articles from a section (requires `section_id`)
- `tag_latest`: newest articles carrying a tag (requires `tag_id`)
- `list_sections`: returns all Guardian sections as a flat list — use to discover valid `section_id` values
- `list_tags`: searches the tag taxonomy with optional `query` and `tag_type` filter — use to discover contributor IDs (`tag_type=contributor`), keyword tags, series, and more
- Pagination applies to all modes

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Guardian-specific:

- Wraps the [Guardian Open Platform API](https://open-platform.theguardian.com/) with a free developer key
- Full body text extraction — HTML stripped, not just headlines or abstracts
- Contributor ID discovery via `guardian_browse` mode `list_tags` + `tag_type=contributor`
- Section and tag taxonomy browsing for filter discovery before searching
- Powered by The Guardian

Agent-friendly output:

- Truncation flags on every article — agents know whether to call `guardian_get_article` for the rest
- Typed error reasons (`unauthorized`, `no_results`, `not_found`, `invalid_date`, `api_error`) with recovery hints for each case
- `total`, `page`, and `pages` on all paginated responses so agents can communicate result scope
- Zero-result enrichment notice on `guardian_search` — echoes the query and suggests how to broaden

---

## Getting started

> **A `GUARDIAN_API_KEY` is required.** Register for the free non-commercial developer key at [https://open-platform.theguardian.com/access](https://open-platform.theguardian.com/access).

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "guardian-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/guardian-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "GUARDIAN_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "guardian-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/guardian-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "GUARDIAN_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "guardian-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "GUARDIAN_API_KEY=your-api-key",
        "ghcr.io/cyanheads/guardian-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 GUARDIAN_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- A free Guardian Open Platform API key — register at [https://open-platform.theguardian.com/access](https://open-platform.theguardian.com/access). The non-commercial developer tier is free and instant.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/guardian-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd guardian-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# Edit .env and set GUARDIAN_API_KEY
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `GUARDIAN_API_KEY` | **Required.** Free developer key from [open-platform.theguardian.com/access](https://open-platform.theguardian.com/access). | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t guardian-mcp-server .
docker run --rm -e GUARDIAN_API_KEY=your-api-key -p 3010:3010 guardian-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/guardian-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and initializes the Guardian service. |
| `src/config` | Server-specific environment variable parsing (`GUARDIAN_API_KEY`). |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`): `guardian_search`, `guardian_get_article`, `guardian_browse`. |
| `src/services/guardian` | Guardian Open Platform API client, normalization, and type definitions. |
| `tests/` | Unit and integration tests. |
| `docs/` | Design document and directory tree. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

---

*Powered by [The Guardian](https://open-platform.theguardian.com/).*
