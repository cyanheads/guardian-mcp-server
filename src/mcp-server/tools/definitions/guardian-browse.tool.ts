/**
 * @fileoverview guardian_browse tool — browse The Guardian by section or tag, or discover
 * available sections and tags. Four modes: section_latest, tag_latest, list_sections, list_tags.
 * Powered by The Guardian.
 * @module mcp-server/tools/definitions/guardian-browse
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGuardianService } from '@/services/guardian/guardian-service.js';
import type { NormalizedArticle } from '@/services/guardian/types.js';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const ArticleBrowseSchema = z.object({
  id: z
    .string()
    .describe('Article ID. Pass to guardian_get_article for the full untruncated text.'),
  headline: z.string().describe('Article headline (HTML stripped).'),
  standfirst: z.string().optional().describe('Sub-headline or article summary (HTML stripped).'),
  byline: z.string().optional().describe('Author attribution (HTML stripped).'),
  section_id: z.string().describe('Section identifier (e.g. "world", "politics").'),
  section_name: z.string().describe('Human-readable section name.'),
  published_date: z.string().describe('Publication date and time (ISO 8601 UTC).'),
  web_url: z.string().describe('Article URL on theguardian.com.'),
  thumbnail: z.string().optional().describe('Thumbnail image URL.'),
  word_count: z
    .number()
    .int()
    .optional()
    .describe('Article word count (absent on some content types).'),
  body: z
    .string()
    .optional()
    .describe(
      'Article body text (HTML stripped). Truncated at 2,000 words. Absent on galleries, live blogs, and interactives.',
    ),
  truncated: z.boolean().describe('True when body was truncated at 2,000 words.'),
});

const SectionSchema = z.object({
  id: z
    .string()
    .describe(
      'Section ID — use as the section parameter in guardian_search or guardian_browse section_latest mode.',
    ),
  name: z.string().describe('Display name (normalized from wire field webTitle).'),
  web_url: z.string().describe('Section URL on theguardian.com.'),
});

const TagSchema = z.object({
  id: z
    .string()
    .describe(
      'Tag ID — use as the tag parameter in guardian_search or guardian_browse tag_latest mode.',
    ),
  type: z
    .string()
    .describe(
      'Tag type: keyword, contributor, blog, series, tone, newspaper-book, newspaper-book-section, type, publication.',
    ),
  name: z.string().describe('Display name (normalized from wire field webTitle).'),
  section_id: z.string().optional().describe('Section this tag belongs to (when applicable).'),
  section_name: z.string().optional().describe('Section display name (when applicable).'),
  web_url: z.string().describe('Tag URL on theguardian.com.'),
});

// ---------------------------------------------------------------------------
// Output schema — flat object with mode discriminant and optional arrays per mode.
// format() renders all fields unconditionally so the linter's sentinel walk passes.
// ---------------------------------------------------------------------------

const OutputSchema = z.object({
  mode: z
    .enum(['section_latest', 'tag_latest', 'list_sections', 'list_tags'])
    .describe(
      'Browse mode that produced this response. ' +
        '"section_latest"/"tag_latest": results[] is populated. ' +
        '"list_sections": sections[] is populated. ' +
        '"list_tags": tags[] is populated.',
    ),
  total: z.number().int().describe('Total items available (articles, sections, or tags).'),
  page: z
    .number()
    .int()
    .optional()
    .describe('Current page number. Present for section_latest, tag_latest, and list_tags modes.'),
  pages: z
    .number()
    .int()
    .optional()
    .describe(
      'Total pages available. Present for section_latest, tag_latest, and list_tags modes.',
    ),
  results: z
    .array(ArticleBrowseSchema.describe('A recent article.'))
    .optional()
    .describe('Recent articles. Populated for section_latest and tag_latest modes.'),
  sections: z
    .array(SectionSchema.describe('A Guardian section.'))
    .optional()
    .describe('All Guardian sections. Populated for list_sections mode.'),
  tags: z
    .array(TagSchema.describe('A Guardian tag.'))
    .optional()
    .describe('Matching tags. Populated for list_tags mode.'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a normalized article to the browse-result shape (drops contributor/pillar fields). */
function toBrowseArticle(a: NormalizedArticle) {
  return {
    id: a.id,
    headline: a.headline,
    ...(a.standfirst !== undefined && { standfirst: a.standfirst }),
    ...(a.byline !== undefined && { byline: a.byline }),
    section_id: a.section_id,
    section_name: a.section_name,
    published_date: a.published_date,
    web_url: a.web_url,
    ...(a.thumbnail !== undefined && { thumbnail: a.thumbnail }),
    ...(a.word_count !== undefined && { word_count: a.word_count }),
    ...(a.body !== undefined && { body: a.body }),
    truncated: a.truncated,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const guardianBrowse = tool('guardian_browse', {
  title: 'Browse The Guardian',
  description:
    "Browse The Guardian's content by section or tag, or discover available sections and tags " +
    'for use as filters. Four modes: "section_latest" returns the newest articles from a section ' +
    '(requires section_id); "tag_latest" returns newest articles carrying a tag (requires tag_id); ' +
    '"list_sections" returns all Guardian sections for use as section filters; "list_tags" searches ' +
    'the tag taxonomy (optional: query, tag_type). Start with list_sections or list_tags when you ' +
    "don't know valid section/tag IDs. Powered by The Guardian (open-platform.theguardian.com).",
  annotations: { readOnlyHint: true },

  input: z.object({
    mode: z
      .enum(['section_latest', 'tag_latest', 'list_sections', 'list_tags'])
      .describe(
        'Operation mode. ' +
          '"section_latest": newest articles from a section (requires section_id). ' +
          '"tag_latest": newest articles carrying a tag (requires tag_id). ' +
          '"list_sections": return all Guardian sections for use as section filters. ' +
          '"list_tags": search the tag taxonomy (optional: query, tag_type, section).',
      ),
    section_id: z
      .string()
      .optional()
      .describe(
        'Section ID for section_latest mode (e.g. "world", "politics", "science", "environment", ' +
          '"technology", "culture", "sport", "lifeandstyle"). Required for section_latest. ' +
          'Use list_sections first if unsure of valid IDs.',
      ),
    tag_id: z
      .string()
      .optional()
      .describe(
        'Tag ID for tag_latest mode (e.g. "environment/climate-change", "technology/artificial-intelligence", ' +
          '"world/ukraine"). Required for tag_latest. Use list_tags first to discover valid tag IDs.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'For list_tags mode: search term to filter the tag taxonomy ' +
          '(e.g. "climate" to find climate-related tags). ' +
          'For list_sections mode: filter sections by name. ' +
          'Ignored for section_latest and tag_latest.',
      ),
    tag_type: z
      .enum([
        'keyword',
        'contributor',
        'blog',
        'series',
        'tone',
        'type',
        'publication',
        'newspaper-book',
        'newspaper-book-section',
      ])
      .optional()
      .describe(
        'For list_tags mode: restrict to tags of this type. ' +
          '"contributor" returns author profiles. "keyword" returns topic tags (most common). ' +
          '"series" returns article series. "newspaper-book" and "newspaper-book-section" cover print categories. ' +
          'Omit to return all types.',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Number of results per page (1–50). Applies to all modes. ' +
          'For article-returning modes (section_latest, tag_latest), keep ≤10 to manage context size.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Page number (1-indexed). Use with total/pages in the response to paginate.'),
  }),

  output: OutputSchema,

  enrichment: {
    totalCount: z
      .number()
      .int()
      .optional()
      .describe(
        'Total items available (articles, sections, or tags) — discloses how many exist beyond this capped page.',
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
      reason: 'missing_section_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'mode is section_latest but section_id is not provided.',
      recovery: 'Provide a section_id. Use mode=list_sections first to discover valid section IDs.',
    },
    {
      reason: 'missing_tag_id',
      code: JsonRpcErrorCode.ValidationError,
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
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const svc = getGuardianService();

    switch (input.mode) {
      case 'section_latest': {
        if (!input.section_id) {
          throw ctx.fail('missing_section_id', 'section_id is required for section_latest mode.', {
            ...ctx.recoveryFor('missing_section_id'),
          });
        }
        ctx.log.info('Browsing section latest', { section_id: input.section_id });
        const result = await svc.getSectionContent(
          input.section_id,
          { page: input.page, page_size: input.page_size },
          ctx,
        );
        if (result.total === 0) {
          throw ctx.fail(
            'section_not_found',
            `Section "${input.section_id}" returned no content — it may not be a valid section ID.`,
            { ...ctx.recoveryFor('section_not_found') },
          );
        }
        ctx.enrich.total(result.total);
        return {
          mode: 'section_latest' as const,
          total: result.total,
          page: result.page,
          pages: result.pages,
          results: result.results.map(toBrowseArticle),
        };
      }

      case 'tag_latest': {
        if (!input.tag_id) {
          throw ctx.fail('missing_tag_id', 'tag_id is required for tag_latest mode.', {
            ...ctx.recoveryFor('missing_tag_id'),
          });
        }
        ctx.log.info('Browsing tag latest', { tag_id: input.tag_id });
        const result = await svc.search(
          {
            query: '',
            tag: input.tag_id,
            order_by: 'newest',
            page: input.page,
            page_size: input.page_size,
          },
          ctx,
        );
        if (result.total === 0) {
          throw ctx.fail(
            'tag_not_found',
            `Tag "${input.tag_id}" returned no content — it may not be a valid tag ID.`,
            { ...ctx.recoveryFor('tag_not_found') },
          );
        }
        ctx.enrich.total(result.total);
        return {
          mode: 'tag_latest' as const,
          total: result.total,
          page: result.page,
          pages: result.pages,
          results: result.results.map(toBrowseArticle),
        };
      }

      case 'list_sections': {
        ctx.log.info('Listing Guardian sections', { query: input.query });
        const result = await svc.getSections(input.query, ctx);
        ctx.enrich.total(result.total);
        return {
          mode: 'list_sections' as const,
          total: result.total,
          sections: result.sections,
        };
      }

      case 'list_tags': {
        ctx.log.info('Listing Guardian tags', { query: input.query, tag_type: input.tag_type });
        const tagsParams: {
          query?: string;
          tag_type?: string;
          page?: number;
          page_size?: number;
        } = { page: input.page, page_size: input.page_size };
        if (input.query !== undefined) tagsParams.query = input.query;
        if (input.tag_type !== undefined) tagsParams.tag_type = input.tag_type;
        const result = await svc.getTags(tagsParams, ctx);
        ctx.enrich.total(result.total);
        return {
          mode: 'list_tags' as const,
          total: result.total,
          page: result.page,
          pages: result.pages,
          tags: result.tags,
        };
      }
    }
  },

  format: (result) => {
    const lines: string[] = [];

    // Always render mode and totals
    lines.push(
      `**mode:** ${result.mode} | **total:** ${result.total}` +
        (result.page != null ? ` | page: ${result.page}/${result.pages ?? '?'}` : ''),
    );
    lines.push('');

    // Articles (section_latest / tag_latest)
    if (result.results != null) {
      for (const article of result.results) {
        lines.push(`## ${article.headline || article.id}`);
        lines.push(
          `**id:** ${article.id} | **section:** ${article.section_name} (${article.section_id}) | **published:** ${article.published_date}`,
        );
        if (article.byline) lines.push(`**by:** ${article.byline}`);
        if (article.standfirst) lines.push(`*${article.standfirst}*`);
        if (article.word_count != null) lines.push(`**words:** ${article.word_count}`);
        lines.push(`**url:** ${article.web_url}`);
        if (article.thumbnail) lines.push(`**thumbnail:** ${article.thumbnail}`);
        if (article.body) {
          lines.push('');
          lines.push(article.body);
          if (article.truncated) {
            lines.push(
              `*(truncated — use guardian_get_article with id "${article.id}" for full text)*`,
            );
          }
        } else {
          lines.push(`**truncated:** ${article.truncated}`);
        }
        lines.push('');
      }
    }

    // Sections (list_sections)
    if (result.sections != null) {
      for (const section of result.sections) {
        lines.push(`- **${section.name}** — id: \`${section.id}\` | ${section.web_url}`);
      }
    }

    // Tags (list_tags)
    if (result.tags != null) {
      for (const tag of result.tags) {
        const sectionPart =
          tag.section_id != null && tag.section_name != null
            ? ` | section: ${tag.section_name} (${tag.section_id})`
            : tag.section_id != null
              ? ` | section_id: ${tag.section_id}`
              : tag.section_name != null
                ? ` | section: ${tag.section_name}`
                : '';
        lines.push(
          `- **${tag.name}** — id: \`${tag.id}\` | type: ${tag.type}${sectionPart} | ${tag.web_url}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
