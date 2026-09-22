/**
 * @fileoverview guardian_search tool — full-text search across The Guardian's archive with
 * optional section, tag, contributor, and date filters. Returns articles with full body text.
 * Powered by The Guardian.
 * @module mcp-server/tools/definitions/guardian-search
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGuardianService } from '@/services/guardian/guardian-service.js';

const ArticleSchema = z.object({
  id: z
    .string()
    .describe(
      'Guardian article ID (path slug, e.g. "world/2024/mar/01/title"). ' +
        'Pass to guardian_get_article to fetch this article directly.',
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
  word_count: z
    .number()
    .int()
    .optional()
    .describe('Article word count (absent on galleries, interactives, and some live content).'),
  body: z
    .string()
    .optional()
    .describe(
      'Full article body text (HTML stripped). Truncated at 2,000 words with a note if longer. ' +
        'Use guardian_get_article with the id for the complete text.',
    ),
  contributors: z
    .array(
      z
        .object({
          id: z
            .string()
            .describe('Contributor tag ID (use as contributor filter in guardian_search).'),
          name: z.string().describe('Contributor display name.'),
        })
        .describe('A contributor attached to this article.'),
    )
    .describe('Authors and contributors attached to this article.'),
  truncated: z.boolean().describe('True when the body was truncated at 2,000 words.'),
});

export const guardianSearch = tool('guardian_search', {
  title: 'Search The Guardian',
  description:
    "Full-text search across The Guardian's archive (1999–present) with optional section, tag, " +
    'contributor, and date filters. Returns articles with full body text (HTML stripped, truncated ' +
    'at 2,000 words). Use guardian_browse with mode=list_sections or mode=list_tags to discover ' +
    'valid filter IDs before searching. Powered by The Guardian (open-platform.theguardian.com).',
  annotations: { readOnlyHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Full-text search query. Supports AND, OR, NOT operators and exact phrases in double quotes. ' +
          'Example: "climate change" AND (policy OR legislation)',
      ),
    section: z
      .string()
      .optional()
      .describe(
        'Restrict results to a section ID (e.g. "world", "politics", "science", "environment", ' +
          '"technology", "culture", "sport", "lifeandstyle"). Use guardian_browse with ' +
          'mode=list_sections to discover valid section IDs.',
      ),
    tag: z
      .string()
      .optional()
      .describe(
        'Restrict to content carrying this tag ID (e.g. "environment/climate-change", ' +
          '"technology/artificial-intelligence", "world/ukraine"). Multiple tags separated by commas ' +
          'apply AND logic. Use guardian_browse with mode=list_tags to discover valid tag IDs.',
      ),
    contributor: z
      .string()
      .optional()
      .describe(
        'Restrict to articles by this contributor tag ID (e.g. "profile/george-monbiot"). ' +
          'Contributor IDs follow the pattern "profile/<slug>". Use guardian_browse with ' +
          'mode=list_tags and tag_type=contributor to discover contributor IDs.',
      ),
    from_date: z
      .string()
      .optional()
      .describe(
        'Return only articles published on or after this date. Format: YYYY-MM-DD (e.g. "2024-01-15").',
      ),
    to_date: z
      .string()
      .optional()
      .describe(
        'Return only articles published on or before this date. Format: YYYY-MM-DD (e.g. "2024-03-31").',
      ),
    order_by: z
      .enum(['newest', 'oldest', 'relevance'])
      .default('relevance')
      .describe(
        'Sort order. "relevance" ranks by match strength (default when a query is provided). ' +
          '"newest" and "oldest" sort by publication date.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Page number (1-indexed). Each page returns up to page_size results.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Number of results per page (1–50). Keep low (≤10) when requesting full body text to ' +
          'manage context size. Large bodies can be 10–30KB each.',
      ),
  }),

  output: z.object({
    total: z.number().int().describe('Total matching articles across all pages.'),
    page: z.number().int().describe('Current page number returned.'),
    pages: z.number().int().describe('Total number of pages available.'),
    page_size: z.number().int().describe('Number of results in this response.'),
    order_by: z.string().describe('Sort order applied.'),
    results: z.array(ArticleSchema.describe('A matching article.')).describe('Matching articles.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .int()
      .optional()
      .describe(
        'Total matching articles across all pages — discloses how many results exist beyond this capped page.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the search returned zero results — echoes the query and suggests how to broaden.',
      ),
  },

  errors: [
    {
      reason: 'unauthorized',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The Guardian API returned 401 — the API key is missing or invalid.',
      recovery:
        'Check that GUARDIAN_API_KEY is set correctly and the key is active at open-platform.theguardian.com.',
      thrownBy: 'service',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query returned zero results.',
      recovery: 'Broaden the query, remove filters, or try different search terms.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'from_date or to_date is not a valid YYYY-MM-DD string.',
      recovery: 'Provide dates in YYYY-MM-DD format, e.g. "2024-01-15".',
    },
    {
      reason: 'api_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Guardian API returned a non-OK status.',
      recovery:
        'Retry after a short delay. If the error persists, the Guardian API may be degraded.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // Validate date formats when provided
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (input.from_date && !dateRe.test(input.from_date)) {
      throw ctx.fail(
        'invalid_date',
        `Invalid from_date "${input.from_date}". Expected YYYY-MM-DD.`,
        { ...ctx.recoveryFor('invalid_date') },
      );
    }
    if (input.to_date && !dateRe.test(input.to_date)) {
      throw ctx.fail('invalid_date', `Invalid to_date "${input.to_date}". Expected YYYY-MM-DD.`, {
        ...ctx.recoveryFor('invalid_date'),
      });
    }

    ctx.log.info('Searching Guardian archive', {
      query: input.query,
      section: input.section,
      tag: input.tag,
      contributor: input.contributor,
      from_date: input.from_date,
      to_date: input.to_date,
      order_by: input.order_by,
      page: input.page,
      page_size: input.page_size,
    });

    const result = await getGuardianService().search(
      {
        query: input.query,
        ...(input.section && { section: input.section }),
        ...(input.tag && { tag: input.tag }),
        ...(input.contributor && { contributor: input.contributor }),
        ...(input.from_date && { from_date: input.from_date }),
        ...(input.to_date && { to_date: input.to_date }),
        order_by: input.order_by,
        page: input.page,
        page_size: input.page_size,
      },
      ctx,
    );

    if (result.total === 0) {
      ctx.enrich.notice(
        `No articles matched "${input.query}". Try broader terms, remove section/tag filters, or adjust the date range.`,
      );
      throw ctx.fail('no_results', `No articles matched "${input.query}".`, {
        ...ctx.recoveryFor('no_results'),
      });
    }

    ctx.enrich.total(result.total);
    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `**Total results:** ${result.total} | **Page:** ${result.page}/${result.pages} | **Per page:** ${result.page_size} | **Sort:** ${result.order_by}`,
      '',
    ];

    for (const article of result.results) {
      lines.push(`## ${article.headline || article.id}`);
      lines.push(
        `**ID:** ${article.id} | **Type:** ${article.type} | **Section:** ${article.section_name} (${article.section_id}) | **Published:** ${article.published_date}`,
      );
      if (article.byline) lines.push(`**By:** ${article.byline}`);
      if (article.standfirst) lines.push(`*${article.standfirst}*`);
      if (article.word_count != null) lines.push(`**Word count:** ${article.word_count}`);
      if (article.thumbnail) lines.push(`**Thumbnail:** ${article.thumbnail}`);
      if (article.contributors.length > 0) {
        const contribs = article.contributors.map((c) => `${c.name} (${c.id})`).join(', ');
        lines.push(`**Contributors:** ${contribs}`);
      }
      lines.push(`**URL:** ${article.web_url}`);
      if (article.body) {
        lines.push('');
        lines.push(article.body);
        if (article.truncated) {
          lines.push(
            `\n*(Body truncated — use guardian_get_article with id "${article.id}" for full text)*`,
          );
        }
      } else {
        lines.push('*(Body not available for this content type)*');
        lines.push(`**Truncated:** ${article.truncated}`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
