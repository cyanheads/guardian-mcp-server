---
name: guardian-guide
description: Use guardian_* tools to research The Guardian's coverage of a topic, find articles by a named author, or follow a story through its archive. Resolve section and tag IDs, combine text and tag filters, and retrieve the complete available text of selected articles.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use the Guardian Open Platform for coverage published by The Guardian. For a comparison across outlets, use this archive for The Guardian's reporting and retrieve the other outlets separately. Commercial use requires an agreement with The Guardian.

## Identifiers

| You have | Resolve it with |
| --- | --- |
| Desk or section name | `guardian_browse_content` in `list_sections` mode. Match the name and copy the section ID. |
| Topic, column, or named author | `guardian_browse_content` in `list_tags` mode. Look for a `keyword` tag for a topic, a `series` tag for a column, or a `contributor` tag for an author. Copy the exact ID, including `profile/` for author profiles. |
| An article to read | Take the result's `id` from search or article browse. A specific article URL on `theguardian.com` or `www.theguardian.com` also works. |

## Gates

- Resolve a named section or tag before filtering. An empty `tag_latest` result can mean that the tag expression matches no articles. Check the individual IDs in `list_tags`, then loosen filters one at a time before drawing conclusions about coverage.
- Treat denied access as an access problem. Check the API key and its permissions before drawing conclusions from the request.
- Use the full-article lookup before quoting text that might fall outside a preview. `truncated: false` alone cannot establish that the response includes a body. Check for body text and report when the API supplies none.
- If Guardian rejects a deep page, split the search into smaller publication-date windows. A reported page count can exceed the pages the API will serve.

## Core chain

Resolve the filters, search or browse with bodies off to shortlist results, then fetch the selected articles with `guardian_get_article`. To follow a story or column from a known article, take a keyword or series tag from its detail and use that ID in a new search or tag browse.

## Workflows

### Latest coverage or archive search

- Use `section_latest` or `tag_latest` for the newest articles in a known section or tag. Use `guardian_search_articles` when the request includes text, a historical window, or a combination of filters. Latest browse ignores the text query. An empty search query applies only the filters and uses newest when the requested sort is relevance.
- For a timeline of a live blog, use `first_published_date` when available. The `published_date` reported by Guardian can advance as the blog is updated.

### Combine topics and contributors

- In full-text search, use double quotes for phrases and `AND`, `OR`, or `NOT` for terms. For example, `"climate change" AND (policy OR legislation)` matches the phrase plus either term.
- In tag filters, use `,` for AND, `|` for OR, and `-` for NOT. Group alternatives before adding a contributor filter. For example, combine `(environment/climate-crisis|environment/flooding)` with `profile/georgemonbiot` to search for articles by that contributor tagged with either topic. The server joins the topic expression and contributor filter with a comma.

## References

[Guardian Open Platform query and filter operators](https://open-platform.theguardian.com/documentation/)
