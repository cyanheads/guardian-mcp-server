/**
 * @fileoverview guardian_get_article tool — fetch a single Guardian article by its ID (path slug)
 * with full body text and all metadata. Powered by The Guardian.
 * @module mcp-server/tools/definitions/guardian-get-article
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGuardianService } from '@/services/guardian/guardian-service.js';

export const guardianGetArticle = tool('guardian_get_article', {
  title: 'Get Guardian Article',
  description:
    'Fetch a single Guardian article by its ID (path slug) with full body text and all metadata. ' +
    'Returns the complete untruncated text for an article ID from guardian_search results. ' +
    'Powered by The Guardian (open-platform.theguardian.com).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    article_id: z
      .string()
      .describe(
        'Guardian article ID — the path slug returned in guardian_search results ' +
          '(e.g. "world/2024/mar/01/russia-ukraine-war-latest"). The id field in search results ' +
          'is the correct value to pass here.',
      ),
  }),

  output: z.object({
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
    word_count: z
      .number()
      .int()
      .optional()
      .describe('Article word count (absent on galleries, interactives, and some live content).'),
    body: z
      .string()
      .describe(
        'Full article body text (HTML stripped). Truncated at 2,000 words with a note appended if longer. ' +
          'Returns a placeholder note for galleries, live blogs, and interactives where body is unavailable.',
      ),
    truncated: z.boolean().describe('True when the body was truncated at 2,000 words.'),
    contributors: z
      .array(
        z
          .object({
            id: z.string().describe('Contributor tag ID.'),
            name: z.string().describe('Contributor display name.'),
          })
          .describe('A contributor attached to this article.'),
      )
      .describe('Authors and contributors.'),
    pillar_id: z.string().optional().describe('Pillar ID (e.g. "pillar/news", "pillar/sport").'),
    pillar_name: z.string().optional().describe('Pillar display name.'),
  }),

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
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No article exists with the given ID.',
      recovery:
        'Verify the article_id matches an id returned by guardian_search. IDs follow the pattern "section/YYYY/mon/DD/slug".',
      thrownBy: 'service',
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
    ctx.log.info('Fetching Guardian article', { article_id: input.article_id });

    const article = await getGuardianService().getContent(input.article_id, ctx);

    // body is required in the output schema — supply a placeholder when absent (non-article types)
    const body =
      article.body ??
      '(Body not available for this content type — may be a gallery, interactive, or live blog.)';

    return {
      id: article.id,
      type: article.type,
      section_id: article.section_id,
      section_name: article.section_name,
      published_date: article.published_date,
      headline: article.headline,
      ...(article.standfirst !== undefined && { standfirst: article.standfirst }),
      ...(article.byline !== undefined && { byline: article.byline }),
      web_url: article.web_url,
      ...(article.thumbnail !== undefined && { thumbnail: article.thumbnail }),
      ...(article.word_count !== undefined && { word_count: article.word_count }),
      body,
      truncated: article.truncated,
      contributors: article.contributors,
      ...(article.pillar_id !== undefined && { pillar_id: article.pillar_id }),
      ...(article.pillar_name !== undefined && { pillar_name: article.pillar_name }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.headline || result.id}`);
    lines.push('');
    lines.push(`**ID:** ${result.id}`);
    lines.push(
      `**Section:** ${result.section_name} (${result.section_id}) | **Published:** ${result.published_date} | **Type:** ${result.type}`,
    );
    if (result.byline) lines.push(`**By:** ${result.byline}`);
    if (result.pillar_id) {
      lines.push(`**Pillar:** ${result.pillar_name ?? result.pillar_id} (${result.pillar_id})`);
    } else if (result.pillar_name) {
      lines.push(`**Pillar:** ${result.pillar_name}`);
    }
    if (result.word_count != null) lines.push(`**Word count:** ${result.word_count}`);
    if (result.contributors.length > 0) {
      const contribs = result.contributors.map((c) => `${c.name} (${c.id})`).join(', ');
      lines.push(`**Contributors:** ${contribs}`);
    }
    lines.push(`**URL:** ${result.web_url}`);
    if (result.thumbnail) lines.push(`**Thumbnail:** ${result.thumbnail}`);
    if (result.standfirst) {
      lines.push('');
      lines.push(`*${result.standfirst}*`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(result.body);
    if (result.truncated) {
      lines.push('');
      lines.push(
        `*(Body truncated at 2,000 words — this is the full text available via the server)*`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
