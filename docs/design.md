# guardian-mcp-server — Design

> Powered by [The Guardian](https://www.theguardian.com) — content available under the [Guardian Open Platform](https://open-platform.theguardian.com) terms. The free (non-commercial) API key is the intended tier.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `guardian_search` | Full-text search across The Guardian's archive (1999–present) with optional section/tag/date filters. Returns articles with full body text. | `query`, `section?`, `tag?`, `contributor?`, `from_date?`, `to_date?`, `order_by?`, `page?`, `page_size?` | `readOnlyHint: true` |
| `guardian_get_article` | Fetch a single Guardian article by its ID (path slug) with full body text and metadata. | `article_id` | `readOnlyHint: true`, `idempotentHint: true` |
| `guardian_browse` | Latest content from a section or tag, or the full list of sections/tags for discovery. Mode controls the operation. | `mode` (`section_latest` \| `tag_latest` \| `list_sections` \| `list_tags`), `section_id?`, `tag_id?`, `query?`, `page_size?`, `page?` | `readOnlyHint: true` |

### Resources

None. All data is reachable through the three tools; no stable-URI resource adds access paths that the tools don't cover.

### Prompts

None. The surface is data/retrieval-focused; no recurring interaction template adds value beyond what tool descriptions provide.

---

## Overview

guardian-mcp-server exposes The Guardian's Open Platform API to LLM agents and tools. It provides full article text — not just headlines and snippets — which is the primary differentiator of this API over most news APIs. The archive spans 1999 to the present across politics, world news, science, environment, culture, sport, technology, and more.

Target audience: researchers, journalists, analysts, educators, and general-purpose AI workflows requiring current-events context or longform journalism for summarization, synthesis, and fact-checking.

Rate limits: 5,000 requests/day, 12 calls/sec on the free (non-commercial) tier.

---

## Requirements

- `GUARDIAN_API_KEY` env var required at startup (fails with `ConfigurationError` if absent)
- Read-only — no write operations exposed
- All article-returning tools request `show-fields=body,headline,byline,thumbnail,wordcount,standfirst` by default
- HTML in `body`, `headline`, `standfirst`, `byline` fields is stripped to plain text before returning
- Articles exceeding 2,000 words are truncated; truncation note appended to body text
- "Powered by The Guardian" attribution included in every tool description
- Free API key is non-commercial only — documented in README; server does not enforce it (caller's responsibility)
- Composes with `wikipedia-mcp-server` (background on topics) and `gdelt-mcp-server` (event data cross-reference)

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `guardian-service` | Guardian Open Platform REST API (`content.guardianapis.com`) | All three tools |

Single service — one API, one key, one base URL. All tools share the same service instance initialized at startup.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `GUARDIAN_API_KEY` | Yes | Guardian Open Platform API key. Non-commercial key available at `open-platform.theguardian.com`. |

---

## Implementation Order

1. Config schema (`src/config/server-config.ts`) — `GUARDIAN_API_KEY` via `parseEnvConfig`
2. Guardian service (`src/services/guardian/`) — HTTP client, HTML stripper, word-count truncator, shared field params
3. `guardian_search` — highest-value tool, full search surface
4. `guardian_get_article` — single-item fetch
5. `guardian_browse` — multi-mode latest/discovery tool

---

## Tool Specifications

### `guardian_search`

**Purpose:** Full-text search across The Guardian's archive with optional filters. Includes full article body text. Powered by The Guardian.

**Upstream endpoint:** `GET https://content.guardianapis.com/search`

**Request params (always sent):**
- `show-fields=body,headline,byline,thumbnail,wordcount,standfirst`
- `show-tags=contributor`
- `format=json`
- `api-key={GUARDIAN_API_KEY}`

**Input schema:**

```ts
z.object({
  query: z.string().describe(
    'Full-text search query. Supports AND, OR, NOT operators and exact phrases in double quotes. '
    + 'Example: "climate change" AND (policy OR legislation)'
  ),
  section: z.string().optional().describe(
    'Restrict results to a section ID (e.g. "world", "politics", "science", "environment", '
    + '"technology", "culture", "sport", "lifeandstyle"). Use guardian_browse with '
    + 'mode=list_sections to discover valid section IDs.'
  ),
  tag: z.string().optional().describe(
    'Restrict to content carrying this tag ID (e.g. "climate-crisis", "artificial-intelligence", '
    + '"ukraine"). Multiple tags separated by commas apply AND logic. Use guardian_browse with '
    + 'mode=list_tags to discover valid tag IDs.'
  ),
  contributor: z.string().optional().describe(
    'Restrict to articles by this contributor tag ID (e.g. "profile/george-monbiot"). '
    + 'Contributor IDs follow the pattern "profile/<slug>". Use guardian_browse with '
    + 'mode=list_tags and type=contributor to discover contributor IDs.'
  ),
  from_date: z.string().optional().describe(
    'Return only articles published on or after this date. Format: YYYY-MM-DD (e.g. "2024-01-15").'
  ),
  to_date: z.string().optional().describe(
    'Return only articles published on or before this date. Format: YYYY-MM-DD (e.g. "2024-03-31").'
  ),
  order_by: z.enum(['newest', 'oldest', 'relevance']).default('relevance').describe(
    'Sort order. "relevance" ranks by match strength (default when a query is provided). '
    + '"newest" and "oldest" sort by publication date.'
  ),
  page: z.number().int().min(1).default(1).describe(
    'Page number (1-indexed). Each page returns up to page_size results.'
  ),
  page_size: z.number().int().min(1).max(50).default(10).describe(
    'Number of results per page (1–50). Keep low (≤10) when requesting full body text to '
    + 'manage context size. Large bodies can be 10–30KB each.'
  ),
})
```

**Output schema:**

```ts
z.object({
  total: z.number().int().describe('Total matching articles across all pages.'),
  page: z.number().int().describe('Current page number returned.'),
  pages: z.number().int().describe('Total number of pages available.'),
  page_size: z.number().int().describe('Number of results in this response.'),
  order_by: z.string().describe('Sort order applied.'),
  results: z.array(
    z.object({
      id: z.string().describe(
        'Guardian article ID (path slug, e.g. "world/2024/mar/01/title"). '
        + 'Pass to guardian_get_article to fetch this article directly.'
      ),
      type: z.string().describe('Content type (typically "article").'),
      section_id: z.string().describe('Section identifier (e.g. "world", "politics").'),
      section_name: z.string().describe('Human-readable section name.'),
      published_date: z.string().describe('Publication date and time (ISO 8601 UTC).'),
      headline: z.string().describe('Article headline (HTML stripped).'),
      standfirst: z.string().optional().describe('Sub-headline or article summary (HTML stripped).'),
      byline: z.string().optional().describe('Author attribution (HTML stripped).'),
      web_url: z.string().describe('URL of the article on theguardian.com.'),
      thumbnail: z.string().optional().describe('URL of the article thumbnail image.'),
      word_count: z.number().int().optional().describe('Article word count.'),
      body: z.string().optional().describe(
        'Full article body text (HTML stripped). Truncated at 2,000 words with a note if longer. '
        + 'Use guardian_get_article with the id for the complete text.'
      ),
      contributors: z.array(z.object({
        id: z.string().describe('Contributor tag ID (use as contributor filter in guardian_search).'),
        name: z.string().describe('Contributor display name.'),
      })).describe('Authors and contributors attached to this article.'),
      truncated: z.boolean().describe('True when the body was truncated at 2,000 words.'),
    })
  ).describe('Matching articles.'),
})
```

**Error contract:**

```ts
errors: [
  {
    reason: 'unauthorized',
    code: JsonRpcErrorCode.Unauthorized,
    when: 'The Guardian API returned 401 — the API key is missing or invalid.',
    recovery: 'Check that GUARDIAN_API_KEY is set correctly and the key is active at open-platform.theguardian.com.',
  },
  {
    reason: 'no_results',
    code: JsonRpcErrorCode.NotFound,
    when: 'The query returned zero results.',
    recovery: 'Broaden the query, remove filters, or try different search terms.',
  },
  {
    reason: 'invalid_date',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'from_date or to_date is not a valid YYYY-MM-DD string.',
    recovery: 'Provide dates in YYYY-MM-DD format, e.g. "2024-01-15".',
  },
  {
    reason: 'api_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The Guardian API returned a non-OK status.',
    recovery: 'Retry after a short delay. If the error persists, the Guardian API may be degraded.',
    retryable: true,
  },
]
```

**Annotations:** `{ readOnlyHint: true }`

---

### `guardian_get_article`

**Purpose:** Fetch a single Guardian article by its ID with full body text and all metadata. Use when the agent already has an article ID from `guardian_search` results and wants the complete untruncated text. Powered by The Guardian.

**Upstream endpoint:** `GET https://content.guardianapis.com/{article_id}`

Note: The single-item endpoint returns `response.content` (not `response.results[]`).

**Request params (always sent):**
- `show-fields=body,headline,byline,thumbnail,wordcount,standfirst`
- `show-tags=contributor`
- `format=json`
- `api-key={GUARDIAN_API_KEY}`

**Input schema:**

```ts
z.object({
  article_id: z.string().describe(
    'Guardian article ID — the path slug returned in guardian_search results '
    + '(e.g. "world/2024/mar/01/russia-ukraine-war-latest"). The id field in search results '
    + 'is the correct value to pass here.'
  ),
})
```

**Output schema:**

```ts
z.object({
  id: z.string().describe('Article ID (path slug).'),
  type: z.string().describe('Content type (typically "article").'),
  section_id: z.string().describe('Section identifier.'),
  section_name: z.string().describe('Human-readable section name.'),
  published_date: z.string().describe('Publication date and time (ISO 8601 UTC).'),
  headline: z.string().describe('Article headline (HTML stripped).'),
  standfirst: z.string().optional().describe('Sub-headline or article summary (HTML stripped).'),
  byline: z.string().optional().describe('Author attribution (HTML stripped).'),
  web_url: z.string().describe('URL on theguardian.com.'),
  thumbnail: z.string().optional().describe('Thumbnail image URL.'),
  word_count: z.number().int().optional().describe('Article word count.'),
  body: z.string().describe(
    'Full article body text (HTML stripped). Truncated at 2,000 words with a note appended if longer.'
  ),
  truncated: z.boolean().describe('True when the body was truncated at 2,000 words.'),
  contributors: z.array(z.object({
    id: z.string().describe('Contributor tag ID.'),
    name: z.string().describe('Contributor display name.'),
  })).describe('Authors and contributors.'),
  pillar_id: z.string().optional().describe('Pillar ID (e.g. "pillar/news", "pillar/sport").'),
  pillar_name: z.string().optional().describe('Pillar display name.'),
})
```

**Error contract:**

```ts
errors: [
  {
    reason: 'unauthorized',
    code: JsonRpcErrorCode.Unauthorized,
    when: 'The Guardian API returned 401 — the API key is missing or invalid.',
    recovery: 'Check that GUARDIAN_API_KEY is set correctly and the key is active at open-platform.theguardian.com.',
  },
  {
    reason: 'not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'No article exists with the given ID.',
    recovery: 'Verify the article_id matches an id returned by guardian_search. '
      + 'IDs follow the pattern "section/YYYY/mon/DD/slug".',
  },
  {
    reason: 'api_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The Guardian API returned a non-OK status.',
    recovery: 'Retry after a short delay.',
    retryable: true,
  },
]
```

**Annotations:** `{ readOnlyHint: true, idempotentHint: true }`

---

### `guardian_browse`

**Purpose:** Browse The Guardian's content by section or tag, or discover available sections and tags for use as filters. Four modes: `section_latest` (newest articles from a section), `tag_latest` (newest articles carrying a tag), `list_sections` (enumerate all sections), `list_tags` (search the tag taxonomy). Powered by The Guardian.

This tool is the entry point for "what's The Guardian saying about X lately?" workflows and for discovering valid section/tag IDs before using `guardian_search` filters.

**Upstream endpoints by mode:**
- `section_latest`: `GET https://content.guardianapis.com/{section_id}` with `show-fields` params
- `tag_latest`: `GET https://content.guardianapis.com/search?tag={tag_id}` with `show-fields` params
- `list_sections`: `GET https://content.guardianapis.com/sections`
- `list_tags`: `GET https://content.guardianapis.com/tags`

**Input schema:**

```ts
z.object({
  mode: z.enum(['section_latest', 'tag_latest', 'list_sections', 'list_tags']).describe(
    'Operation mode. '
    + '"section_latest": newest articles from a section (requires section_id). '
    + '"tag_latest": newest articles carrying a tag (requires tag_id). '
    + '"list_sections": return all Guardian sections for use as section filters. '
    + '"list_tags": search the tag taxonomy (optional: query, tag_type, section).'
  ),
  section_id: z.string().optional().describe(
    'Section ID for section_latest mode (e.g. "world", "politics", "science", "environment", '
    + '"technology", "culture", "sport", "lifeandstyle"). Required for section_latest. '
    + 'Use list_sections first if unsure of valid IDs.'
  ),
  tag_id: z.string().optional().describe(
    'Tag ID for tag_latest mode (e.g. "environment/climate-change", "technology/artificial-intelligence", '
    + '"world/ukraine"). Required for tag_latest. Use list_tags first to discover valid tag IDs.'
  ),
  query: z.string().optional().describe(
    'For list_tags mode: search term to filter the tag taxonomy '
    + '(e.g. "climate" to find climate-related tags). '
    + 'For list_sections mode: filter sections by name. '
    + 'Ignored for section_latest and tag_latest.'
  ),
  tag_type: z.enum(['keyword', 'contributor', 'blog', 'series', 'tone', 'type', 'publication', 'newspaper-book', 'newspaper-book-section']).optional().describe(
    'For list_tags mode: restrict to tags of this type. '
    + '"contributor" returns author profiles. "keyword" returns topic tags (most common). '
    + '"series" returns article series. "newspaper-book" and "newspaper-book-section" cover print categories. '
    + 'Omit to return all types.'
  ),
  page_size: z.number().int().min(1).max(50).default(10).describe(
    'Number of results per page (1–50). Applies to all modes. '
    + 'For article-returning modes (section_latest, tag_latest), keep ≤10 to manage context size.'
  ),
  page: z.number().int().min(1).default(1).describe(
    'Page number (1-indexed). Use with total/pages in the response to paginate.'
  ),
})
```

**Output schema:**

Discriminated union across modes. The `mode` field echoes the input so the caller can interpret the result.

```ts
z.discriminatedUnion('mode', [
  // section_latest and tag_latest share the articles shape
  // Note: section_latest endpoint does not return orderBy in the response envelope.
  // tag_latest routes through /search which does include orderBy.
  // Both are normalized to the same output shape; orderBy is omitted entirely.
  z.object({
    mode: z.enum(['section_latest', 'tag_latest']),
    total: z.number().int().describe('Total available articles.'),
    page: z.number().int(),
    pages: z.number().int(),
    results: z.array(
      z.object({
        id: z.string().describe('Article ID. Pass to guardian_get_article for the full untruncated text.'),
        headline: z.string(),
        standfirst: z.string().optional(),
        byline: z.string().optional(),
        section_id: z.string(),
        section_name: z.string(),
        published_date: z.string().describe('ISO 8601 UTC.'),
        web_url: z.string(),
        thumbnail: z.string().optional(),
        word_count: z.number().int().optional(),
        body: z.string().optional().describe(
          'Article body text (HTML stripped). Truncated at 2,000 words.'
        ),
        truncated: z.boolean(),
      })
    ).describe('Recent articles.'),
  }),
  // list_sections
  z.object({
    mode: z.literal('list_sections'),
    total: z.number().int(),
    sections: z.array(
      z.object({
        id: z.string().describe('Section ID — use as the section parameter in guardian_search or guardian_browse section_latest mode.'),
        name: z.string().describe('Display name (normalized from wire field webTitle).'),
        web_url: z.string(),
      })
    ),
  }),
  // list_tags
  z.object({
    mode: z.literal('list_tags'),
    total: z.number().int(),
    page: z.number().int(),
    pages: z.number().int(),
    tags: z.array(
      z.object({
        id: z.string().describe('Tag ID — use as the tag parameter in guardian_search or guardian_browse tag_latest mode.'),
        type: z.string().describe('Tag type: keyword, contributor, blog, series, tone, newspaper-book, newspaper-book-section, type, publication.'),
        name: z.string().describe('Display name (normalized from wire field webTitle).'),
        section_id: z.string().optional(),
        section_name: z.string().optional(),
        web_url: z.string(),
      })
    ),
  }),
])
```

**Error contract:**

```ts
errors: [
  {
    reason: 'unauthorized',
    code: JsonRpcErrorCode.Unauthorized,
    when: 'The Guardian API returned 401 — the API key is missing or invalid.',
    recovery: 'Check that GUARDIAN_API_KEY is set correctly and the key is active at open-platform.theguardian.com.',
  },
  {
    reason: 'missing_section_id',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'mode is section_latest but section_id is not provided.',
    recovery: 'Provide a section_id. Use mode=list_sections first to discover valid section IDs.',
  },
  {
    reason: 'missing_tag_id',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'mode is tag_latest but tag_id is not provided.',
    recovery: 'Provide a tag_id. Use mode=list_tags with a query to discover valid tag IDs.',
  },
  {
    reason: 'section_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'The given section_id does not match any Guardian section.',
    recovery: 'Use mode=list_sections to list all valid section IDs.',
  },
  {
    reason: 'tag_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'The given tag_id returned no content.',
    recovery: 'Use mode=list_tags with a query to find the correct tag ID.',
  },
  {
    reason: 'api_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The Guardian API returned a non-OK status.',
    recovery: 'Retry after a short delay.',
    retryable: true,
  },
]
```

**Annotations:** `{ readOnlyHint: true }`

---

## Service Layer

### `guardian-service` (`src/services/guardian/`)

**Files:**
- `guardian-service.ts` — init/accessor pattern, exports `getGuardianService()`
- `types.ts` — raw API response types (close to wire shape) and normalized domain types

**Responsibilities:**
- HTTP client wrapping `fetchWithTimeout` + `withRetry` from `@cyanheads/mcp-ts-core/utils`
- Injects `api-key`, `format=json`, and `show-fields` params on all content-returning requests
- Strips HTML from `body`, `headline`, `standfirst`, `byline` fields (use a lightweight regex-based stripper — no DOM parser dependency). Live probe confirms `body` and `standfirst` contain HTML (`<p>`, `<ul>`, `<li>`, `<a>`, `<strong>` etc.); `headline` and `byline` may come back plain but strip defensively.
- Truncates article body at 2,000 words, appends `\n\n[Article truncated at 2,000 words. Use guardian_get_article with id "${id}" to retrieve the full text.]`
- Parses `wordcount` from string (the API returns it as `String (Integer)`) to `number`
- Extracts `show-fields` values from the nested `fields: {}` sub-object in each result (confirmed live: `headline`, `standfirst`, `byline`, `body`, `wordcount`, `thumbnail` all nest under `fields`, not at the result root)
- Normalizes camelCase API field names: `sectionId` → `section_id`, `webPublicationDate` → `published_date`, `webTitle` → `name` (sections and tags), `webUrl` → `web_url`, `pillarId` → `pillar_id`, `pillarName` → `pillar_name`
- Maps `show-tags=contributor` response (each tag has `id`, `webTitle`, plus optional profile fields) into the `contributors[]` array: `webTitle` → `name`, `id` → `id`

**Service methods (internal — not tool-shaped):**
- `search(params)` → normalized search response
- `getContent(articleId)` → normalized single-item response
- `getSectionContent(sectionId, pageParams)` → normalized search response (section-scoped)
- `getSections(query?)` → sections list
- `getTags(params)` → tags list

**Resilience config:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Service method wraps the full fetch + parse pipeline |
| Retries | 3 attempts, exponential backoff, base 500ms (rate limit recovery), jitter |
| Timeout | 10s per request |
| Non-OK HTTP | `fetchWithTimeout` → `ServiceUnavailable` |
| HTML error page | Detect `Content-Type: text/html` on API response → `ServiceUnavailable` (transient), not `SerializationError` |
| 429 | Treat as transient → retried with backoff |

---

## API Reference

**Base URL:** `https://content.guardianapis.com`

**Authentication:** `api-key` query param on every request.

**Response envelope:**

```json
{
  "response": {
    "status": "ok",
    "userTier": "developer",
    "total": 5857,
    "startIndex": 1,
    "pageSize": 10,
    "currentPage": 1,
    "pages": 586,
    "orderBy": "newest",
    "results": [ ... ]        // search and section endpoints
    // OR
    "content": { ... }        // single-item endpoint
    // OR
    "results": [ ... ]        // tags and sections endpoints (no orderBy)
  }
}
```

**Key `show-fields` values (all fields are strings on the wire — parse as needed):**

| Field | Wire type | Notes |
|:------|:----------|:------|
| `body` | String (HTML) | Strip HTML before returning |
| `headline` | String (HTML) | Strip HTML |
| `standfirst` | String (HTML) | Strip HTML; sub-headline/summary |
| `byline` | String (HTML) | Strip HTML |
| `thumbnail` | String | URL; may be absent |
| `wordcount` | String (Integer) | Parse to number |

**Pagination:** `page` (1-indexed) and `page-size` (1–50). Deep pagination beyond a few thousand results requires the `/next` cursor endpoint — out of scope for this server's design.

**Rate limits:** 5,000 requests/day, 12 calls/sec on the free tier.

**Tag `type` values:** `keyword`, `contributor`, `blog`, `series`, `tone`, `newspaper-book`, `newspaper-book-section`, `type`, `publication`

**`order-by` values:** `newest` (default for browse), `oldest`, `relevance` (default when `q` is present)

---

## Design Decisions

**1. Three tools instead of five.**
The idea.md sketch listed `guardian_search`, `guardian_get_article`, `guardian_browse`, and `guardian_list_tags` as separate tools. Sections and tags share the same browse/discovery purpose and the same usage pattern (discover IDs before filtering), so they collapse into `guardian_browse` with a `mode` enum. This keeps the surface minimal — four distinct operations via three tools.

**2. `show-fields` by default on all article-returning tools.**
Every tool that returns articles requests `show-fields=body,headline,byline,thumbnail,wordcount,standfirst` unconditionally. The server's value proposition is full article text; stripping the body to save tokens defeats the purpose. Callers who want metadata-only can use `guardian_browse mode=list_sections` or `list_tags`.

**3. Word-count truncation at 2,000 words with an explicit note.**
Guardian articles range from 300 to 8,000+ words. Returning a 30KB article body would exhaust most context budgets when `page_size=10`. Truncation at 2,000 words (≈ 12–15KB per article at full page) keeps the tool usable in batch. The truncation note names the article ID so the agent can fetch the full text via `guardian_get_article` if needed. The threshold is design-time fixed; no knob — a knob would just push the decision onto the caller.

**4. HTML stripping is mandatory, not optional.**
The Guardian API returns HTML in `body`, `headline`, `standfirst`, and `byline`. Returning raw HTML to an LLM is noise; the model reads entities (`&amp;`, `&nbsp;`) and tags (`<p>`, `<strong>`, `<a href=...>`) as literal content. The service layer strips unconditionally. No `raw_html` parameter is exposed.

**5. `contributor` as a first-class `guardian_search` param.**
The Guardian tag system encodes contributors as `type=contributor` tags under the `profile/` namespace. Exposing `contributor` separately from the generic `tag` parameter gives the common case a clear label and saves the caller from knowing the Guardian tag-type system. The service layer maps it to a `tag=profile/{slug}` API param.

**6. `guardian_browse mode=tag_latest` routes to `/search?tag=` not `/{tag_id}`.**
The Guardian's section endpoint (`/{section_id}`) supports browsing latest content. Tags don't have an equivalent direct endpoint — fetching latest content by tag requires `/search?tag=`. The service abstracts this routing detail; both modes surface the same article shape.

**7. No `page_size` knob for `list_sections`.**
Sections return the full list in one call (around 50–100 sections, no pagination in practice). Sections are not paginated in the API response and the full list fits easily in one response. The `page_size` input is accepted but only meaningful for paginated modes — `list_sections` ignores it cleanly.

**8. No resources.**
All data is reachable through tools. The Guardian's content isn't addressable in a way that adds value as injectable context (you'd still need the full article text, which belongs in tool output, not resource content). Tool-only agents can do everything the server is for.

**9. Free-tier non-commercial restriction.**
The server doesn't enforce the non-commercial restriction (it has no mechanism to do so). The README must prominently note that the free API key is non-commercial-only and link to the Guardian's commercial licensing. The `GUARDIAN_API_KEY` description in server config and server instructions should note this.

---

## Known Limitations

- **Free tier is non-commercial only.** Commercial use requires a separate agreement with The Guardian. The server cannot enforce this.
- **Pagination depth.** Deep pagination (beyond ~2,500 results) requires the `/next` cursor endpoint, which this server does not expose. For deep historical research, use narrow `from_date`/`to_date` windows to stay within the page-based limit.
- **`wordcount` is string-typed.** The API returns `wordcount` as `String (Integer)`. The service layer parses it; absent values map to `undefined`, not `0`.
- **`body` may be absent.** Some content types (live blogs, galleries, interactive features) may not populate the `body` field even with `show-fields=body`. The output schema marks `body` as optional; the formatted output notes when it is absent.
- **HTML in fields.** Some HTML tags may remain after stripping if they contain nested structures the regex stripper doesn't handle (e.g., complex table markup). Field-testing should verify the stripper handles common Guardian article patterns.
- **No `/next` cursor pagination.** The design uses page-number pagination only. The Guardian's cursor-based `/next` endpoint for deep pagination is out of scope.
- **Rate limit has no server-side enforcement.** The server does not track or throttle request rates. Callers consuming the server at high volume are responsible for staying within 12 calls/sec and 5,000/day.

---

## Decisions Log

| # | Decision | Rationale |
|:--|:---------|:----------|
| 1 | Live API probing performed during design review using the public test key (`api-key=test`). | Design agent had no `GUARDIAN_API_KEY`; design review used the public test key to verify response shapes. Key findings: `show-fields` values nest under `fields: {}` sub-object; sections and tags use `webTitle` (not `name`); `response.content` confirmed for single-item; `pillarId`/`pillarName` confirmed at result root; contributor tag shape confirmed. See "Fields verified via live probe" table below. |
| 2 | Fields requiring authenticated key still flagged for field-test. | Complex article HTML structure, `wordcount`/`standfirst`/`byline` absence in non-standard content types, and 429 shape need an authenticated key to fully verify. |
| 3 | `guardian_browse` uses a `mode` enum, not four separate tools. | See Design Decision #1. |
| 4 | `show-fields` requested on all article-returning tools by default. | See Design Decision #2. |
| 5 | Truncation at 2,000 words, fixed, no knob. | See Design Decision #3. |
| 6 | HTML stripping is unconditional. | See Design Decision #4. |
| 7 | `contributor` param is a first-class `guardian_search` input. | See Design Decision #5. |
| 8 | No resources or prompts. | See MCP Surface and Design Decision #8. |
| 9 | Free-tier non-commercial restriction noted in README only, not enforced. | See Design Decision #9. |
| 10 | `section_latest` output omits `orderBy`. | Live probe confirms the `/{section_id}` endpoint returns `orderBy: null` in the response envelope. Omitting it avoids surfacing a null field; the section content is implicitly newest-first. |
| 11 | `tag_type` enum includes `newspaper-book` and `newspaper-book-section`. | Both are valid tag types per the Guardian docs. The original design omitted them; added during review. |
| 12 | `unauthorized` error added to all three tool error contracts. | 401 is a predictable, concrete failure on missing/invalid API key. The agent needs a clear recovery hint pointing to `GUARDIAN_API_KEY` configuration. |

### Fields verified via live probe (public test key, review phase)

The design review performed live probing using the Guardian's public test key (`api-key=test`), confirming the following:

| Field | Status | Finding |
|:------|:-------|:--------|
| `body` HTML structure | **Confirmed** | Uses `<p>`, `<ul>`, `<li>`, `<a href="...">`, `<strong>`. Standard paragraph HTML. Regex stripper must handle these at minimum. Field is nested under `result.fields.body`. |
| `show-fields` nesting | **Confirmed** | `headline`, `standfirst`, `byline`, `body`, `wordcount`, `thumbnail` are all nested under a `fields: {}` sub-object on each result — not flat at the result root. Service must extract them. |
| `wordcount` type | **Confirmed** | Returns as `"495"` (string). Parse to number. |
| `standfirst` HTML | **Confirmed** | Contains HTML (`<ul><li>...`). Must be stripped. |
| `byline` | **Confirmed** | Plain string in the tested article (`"Author Name, Role"`). No HTML tags observed. Strip defensively. |
| `contributor` tag shape | **Confirmed** | Tag objects in `tags[]` on content include: `id`, `type`, `webTitle`, `webUrl`, `apiUrl`, `references`, `bio`, `bylineImageUrl`, `bylineLargeImageUrl`, `firstName`, `lastName`, `twitterHandle`. Map `webTitle` → `name`. |
| `response.content` for single-item | **Confirmed** | Single-item endpoint returns `response.content: {}` (not `response.results[]`). Verified live. |
| `pillarId` / `pillarName` | **Confirmed** | Present at the result root (not under `fields`). Both search results and single-item responses include them. Safe to mark optional (may be absent on non-article types). |
| Sections `webTitle` | **Confirmed** | Sections use `webTitle` (not `name`). Service maps `webTitle` → `name` in output. Verified: ~80 sections returned by `/sections`. |
| Tags `webTitle` | **Confirmed** | Tags use `webTitle` (not `name`). Service maps `webTitle` → `name` in output. |
| Section content endpoint order | **Confirmed** | `/{section_id}` endpoint returns content with `orderBy: null` — no orderBy in section responses. The `orderBy` field in `guardian_browse` section_latest output should be omitted. |

### Fields remaining for field-test (need authenticated key)

| Field | Risk | How to verify |
|:------|:-----|:--------------|
| `body` complex HTML | Public test key returns simple `<p>` markup. Long-form articles may include `<figure>`, `<picture>`, `<aside>`, `<blockquote>`. | Fetch 5+ full articles with authenticated key; inspect raw `body` before stripping. |
| `wordcount` absence | Non-article types (galleries, interactives) may omit `wordcount`. | Search without `type=article` filter; check sparse payloads. |
| `standfirst` absence | Shorter articles or opinions may omit it. | Confirm some articles genuinely lack it (assumed optional). |
| `byline` absence | Wire stories or breaking news may lack a byline. | Confirm with a news brief. |
| 429 response shape | Docs don't document the rate-limit error body. | Trigger a 429 or check the Guardian API status docs. |
