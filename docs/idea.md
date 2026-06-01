# guardian-mcp-server — idea

Quality journalism and news archive via The Guardian's Open Platform API. Full article body (not just metadata), bylines, tags, and section structure — 1999 to present across politics, world news, science, environment, culture, sport, and more. 5,000 requests/day on the free tier.

The differentiator: **full article text** on the free tier. Many news APIs return headlines and snippets only; The Guardian returns the actual journalism — useful for summarization, research, and synthesis workflows.

**Audience:** Researchers, journalists, analysts, content creators, educators, and general-purpose AI workflows requiring current-events context or longform text.

## User Goals

- Search for recent coverage of a topic, event, or person
- Read the full text of a specific article
- Browse coverage by section (world, politics, science, environment, culture, sport)
- Find all articles by a specific contributor or on a specific tag
- Get a section's latest articles for a topic digest
- Retrieve coverage from a specific date range or time period

## API

Single REST API, key required (free tier, non-commercial). 5,000 req/day, 12 calls/sec. Get a key at `open-platform.theguardian.com`.

| Endpoint | Purpose |
|:---------|:--------|
| `/search` | Full-text search with filters: section, tag, contributor, date range, language. Optional `show-fields=body` returns full article text. |
| `/[section]` | Latest content from a specific section or sub-section |
| `/tags` | Browse and search the tag taxonomy |
| `/sections` | List all available sections |
| `/[article-id]` | Fetch a single article by its path ID |

The `show-fields` parameter is what makes this API stand out — `body,headline,byline,thumbnail,wordcount,standfirst` returns a rich content object. Without it, responses are metadata only. Request the full fields by default.

## Tool Surface (sketch)

```
guardian_search      — primary search tool. Query + optional filters: section, tags,
                       contributor, date_from, date_to, page, page_size.
                       Returns results with full article body when requested.
                       Includes headline, byline, section, publication date, word count,
                       standfirst (subheading), thumbnail URL, and article ID for
                       follow-up. Faceted response includes total result count.
                       Default: includes body text — this is the value-add.

guardian_get_article — fetch a single article by its Guardian ID (path slug).
                       Returns full metadata + body. Use when the agent has an ID
                       from search results and wants the complete article.

guardian_browse      — latest content by section or tag. Mode:
                       'section' — latest from a named section (world, politics,
                         science, environment, technology, culture, sport, lifeandstyle)
                       'tag' — latest for a specific tag (e.g. 'climate-crisis',
                         'artificial-intelligence', 'ukraine')
                       Returns most recent N articles with body.
                       Entry point for "what's The Guardian saying about X lately?"

guardian_list_tags   — search the tag taxonomy. Useful for discovering valid tag
                       strings before filtering guardian_search. Returns tags with
                       their section and type (keyword, contributor, series, tone).
                       Also surfaces contributor profiles (byline metadata).
```

## Design Notes

- Low complexity — clean REST API, one key, well-documented. Fast build.
- The `show-fields=body` parameter is the entire point. Every tool that returns articles should request it by default; only omit for list/browse endpoints where the caller explicitly wants metadata only.
- Output format: structured markdown per article — headline, byline, section, date, then the body. The Guardian body is clean HTML; strip tags before returning.
- `guardian_browse` with section/tag modes collapses what could be multiple endpoint-specific tools into one. An enum on `mode` keeps the surface minimal.
- Tags are the filtering backbone — `guardian_list_tags` prevents bad filter values and surfaces the contributor graph.
- Rate limit is generous (5K/day) but full-body responses are large. Truncate long articles (>2K words) with an explicit truncation note to keep context usage reasonable.
- **Attribution required:** "Powered by The Guardian" with a link, in tool descriptions and README.
- **Licensing:** the free key is non-commercial only (and a commercial license is a separate tier) — note this in the README. The server itself runs against the live API with a caller-supplied key.
- Composes naturally with `wikipedia` (background on topics surfaced in articles) and `gdelt` (event data to cross-reference coverage).

**README one-liner:** "Access The Guardian's archive of journalism from 1999 to present — with full article text."
