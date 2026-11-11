/**
 * @fileoverview guardian_search_articles tool — full-text search across The Guardian's archive with
 * optional section, tag, contributor, and date filters. Returns optional article body previews.
 * Powered by The Guardian.
 * @module mcp-server/tools/definitions/guardian-search-articles
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  escapeMarkdownInline as literal,
  markdownImage,
  markdownLink,
} from '@cyanheads/mcp-ts-core/utils';
import { getGuardianService } from '@/services/guardian/guardian-service.js';

/** Validate calendar dates without timezone normalization. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

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
      'Article body preview (HTML stripped), up to 2,000 words with a note when truncated. Omitted when include_body is false or Guardian supplies no body text. Use guardian_get_article with this id as article_id for the complete text.',
    ),
  contributors: z
    .array(
      z
        .object({
          id: z
            .string()
            .describe(
              'Contributor tag ID (use as contributor filter in guardian_search_articles).',
            ),
          name: z.string().describe('Contributor display name.'),
        })
        .describe('A contributor attached to this article.'),
    )
    .describe('Authors and contributors attached to this article.'),
  truncated: z.boolean().describe('True when the body was truncated at 2,000 words.'),
});

export const guardianSearchArticles = tool('guardian_search_articles', {
  title: 'Search Guardian Articles',
  description:
    "Full-text search across The Guardian's archive (1999–present) with optional section, tag, contributor, and date filters. Returns body previews up to 2,000 words by default. Use guardian_browse_content with mode=list_sections or mode=list_tags to discover filter IDs. Powered by The Guardian (open-platform.theguardian.com).",
  annotations: { readOnlyHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Full-text search query. Pass an empty string to search by filters alone. Supports AND, OR, NOT operators and exact phrases in double quotes, e.g. "climate change" AND (policy OR legislation).',
      ),
    section: z
      .string()
      .optional()
      .describe(
        'Restrict results to a section ID (e.g. "world", "politics", "science", "environment", ' +
          '"technology", "culture", "sport", "lifeandstyle"). Use guardian_browse_content with ' +
          'mode=list_sections to discover valid section IDs.',
      ),
    tag: z
      .string()
      .optional()
      .describe(
        'Restrict to content carrying this tag ID (e.g. "environment/climate-crisis", ' +
          '"technology/artificial-intelligence", "world/ukraine"). Supports comma (AND), pipe | (OR), ' +
          'hyphen - (NOT), and parentheses. OR example: environment/climate-crisis|environment/flooding. ' +
          'When combining with contributor, group compound expressions: (environment/climate-crisis|environment/flooding). ' +
          'The service comma-joins tag and the contributor filter. Use guardian_browse_content with mode=list_tags to discover valid tag IDs.',
      ),
    contributor: z
      .string()
      .optional()
      .describe(
        'Restrict to articles by a contributor tag ID (e.g. "profile/georgemonbiot"). Bare slugs receive the profile/ prefix. Boolean tag expressions pass through unchanged. Use guardian_browse_content with mode=list_tags and tag_type=contributor to discover IDs.',
      ),
    from_date: z
      .string()
      .optional()
      .describe(
        'Return only articles published on or after this real calendar date. Format: YYYY-MM-DD (e.g. "2024-01-15"). Blank is omitted.',
      ),
    to_date: z
      .string()
      .optional()
      .describe(
        'Return only articles published on or before this real calendar date. Format: YYYY-MM-DD (e.g. "2024-03-31"). Blank is omitted.',
      ),
    order_by: z
      .enum(['newest', 'oldest', 'relevance'])
      .default('relevance')
      .describe(
        'Sort order. "relevance" is the default for a nonblank query and falls back to "newest" without one. "newest" and "oldest" sort by publication date.',
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
        'Number of results per page (1–50). Set include_body to false to scan larger pages without article text.',
      ),
    include_body: z
      .boolean()
      .default(true)
      .describe(
        'Include body previews up to 2,000 words per article. Set false for metadata only. Use guardian_get_article for complete text.',
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
      .describe('Explains why a blank query uses newest instead of relevance.'),
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
      when: 'A date is invalid or from_date is later than to_date.',
      recovery:
        'Provide real calendar dates in YYYY-MM-DD format with from_date on or before to_date.',
    },
    {
      reason: 'request_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The Guardian API returned HTTP 400.',
      recovery:
        'Use an earlier page or narrow from_date and to_date. Guardian can reject paging past 38,000 results even within the reported page count.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'access_denied',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The Guardian API denied access.',
      recovery: 'Check the API key permissions and Guardian access limits before trying again.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'validation_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The Guardian API rejected a parameter value.',
      recovery: 'Correct the supplied parameter values before trying the request again.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'The Guardian API cannot serve this request.',
      recovery: 'Check the requested operation and parameters before trying again.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'request_conflict',
      code: JsonRpcErrorCode.Conflict,
      when: 'The Guardian API reported a request conflict.',
      recovery: 'Review the request parameters and resolve the conflict before trying again.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'request_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The Guardian API could not find the requested endpoint.',
      recovery: 'Check the requested operation and identifiers before trying again.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'api_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The Guardian request timed out or the API returned a timeout status.',
      recovery: 'Retry after a short delay with the same request.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Guardian API returned HTTP 429.',
      recovery: 'Wait for the Guardian rate limit to reset before retrying.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'api_unsupported',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Guardian API returned HTTP 501.',
      recovery: 'Check the requested operation; repeating the same request will not help.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'api_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Guardian API returned a retryable server failure (excluding HTTP 501), an HTML error page, or a network failure.',
      recovery:
        'Retry after a short delay. If the error persists, the Guardian API may be degraded.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (input.from_date && !isCalendarDate(input.from_date)) {
      throw ctx.fail(
        'invalid_date',
        `Invalid from_date "${input.from_date}". Expected YYYY-MM-DD.`,
      );
    }
    if (input.to_date && !isCalendarDate(input.to_date)) {
      throw ctx.fail('invalid_date', `Invalid to_date "${input.to_date}". Expected YYYY-MM-DD.`);
    }
    if (input.from_date && input.to_date && input.from_date > input.to_date) {
      throw ctx.fail(
        'invalid_date',
        `from_date "${input.from_date}" is later than to_date "${input.to_date}".`,
      );
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
        include_body: input.include_body,
      },
      ctx,
    );

    if (result.total === 0) {
      const filters = Object.entries({
        query: input.query,
        section: input.section,
        tag: input.tag,
        contributor: input.contributor,
        from_date: input.from_date,
        to_date: input.to_date,
      }).flatMap(([key, value]) => (value?.trim() ? [`${key} "${value}"`] : []));
      throw ctx.fail(
        'no_results',
        filters.length
          ? `No articles matched ${filters.join(', ')}.`
          : 'No articles were returned.',
      );
    }

    if (!input.query.trim() && input.order_by === 'relevance') {
      ctx.enrich.notice(
        'Sorted by newest because the query is blank and relevance requires search terms.',
      );
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
      lines.push(`## ${literal(article.headline || article.id).replaceAll('\\\n', '&#10;')}`);
      lines.push(
        `**ID:** ${literal(article.id)} | **Type:** ${literal(article.type)} | **Section:** ${literal(article.section_name)} (${literal(article.section_id)}) | **Published:** ${literal(article.published_date)}`,
      );
      if (article.byline !== undefined) lines.push(`**By:** ${literal(article.byline)}`);
      if (article.standfirst !== undefined)
        lines.push(`**Standfirst:** ${literal(article.standfirst)}`);
      if (article.word_count != null) lines.push(`**Word count:** ${article.word_count}`);
      if (article.thumbnail !== undefined)
        lines.push(`**Thumbnail:** ${markdownImage('Article thumbnail', article.thumbnail)}`);
      if (article.contributors.length > 0) {
        const contribs = article.contributors
          .map((c) => `${literal(c.name)} (${literal(c.id)})`)
          .join(', ');
        lines.push(`**Contributors:** ${contribs}`);
      }
      lines.push(`**URL:** ${markdownLink(article.web_url, article.web_url)}`);
      lines.push(`**Truncated:** ${article.truncated}`);
      if (article.body !== undefined) {
        lines.push('', literal(article.body));
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
