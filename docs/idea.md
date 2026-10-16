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

## Tool Surface

```
guardian_search_articles — query plus optional section, tag, contributor, from_date,
                           to_date, order_by, page, and page_size filters. Returns
                           metadata and capped body previews with article IDs.

guardian_get_article     — article_id selects one complete HTML-stripped article
                           with metadata and no word cap.

guardian_browse_content  — section_latest and tag_latest return capped previews;
                           list_sections and list_tags discover valid filter IDs.
                           list_tags with tag_type=contributor finds author profiles.
```

## Design Notes

- Low complexity — clean REST API, one key, well-documented. Fast build.
- The `show-fields=body` parameter is the entire point. Every tool that returns articles should request it by default; only omit for list/browse endpoints where the caller explicitly wants metadata only.
- Output format: structured markdown per article — headline, byline, section, date, then the body. The Guardian body is clean HTML; strip tags before returning.
- `guardian_browse_content` with section/tag modes collapses what could be multiple endpoint-specific tools into one. An enum on `mode` keeps the surface minimal.
- Tags are the filtering backbone — `guardian_browse_content` with `mode=list_tags` discovers valid IDs and contributor profiles.
- Search and browse previews cap long bodies at 2,000 words with an explicit truncation state and continuation naming `article_id`. Single-article retrieval returns complete HTML-stripped text without a word cap.
- **Attribution required:** "Powered by The Guardian" with a link, in tool descriptions and README.
- **Licensing:** the free key is non-commercial only (and a commercial license is a separate tier) — note this in the README. The server itself runs against the live API with a caller-supplied key.
- Composes naturally with `wikipedia` (background on topics surfaced in articles) and `gdelt` (event data to cross-reference coverage).

**README one-liner:** "Access The Guardian's archive of journalism from 1999 to present — with full article text."
