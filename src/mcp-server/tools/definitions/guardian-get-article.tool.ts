/**
 * @fileoverview guardian_get_article tool — fetch a single Guardian article by its ID (path slug)
 * with full body text and all metadata. Powered by The Guardian.
 * @module mcp-server/tools/definitions/guardian-get-article
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  escapeMarkdownInline as literal,
  markdownImage,
  markdownLink,
} from '@cyanheads/mcp-ts-core/utils';
import { getGuardianService } from '@/services/guardian/guardian-service.js';
import { ArticleTagTypeSchema } from '@/services/guardian/types.js';

export const guardianGetArticle = tool('guardian_get_article', {
  title: 'Get Guardian Article',
  description:
    'Fetch a Guardian article by its ID or Guardian web URL. Returns the complete available body, article metadata, and topic and editorial tags. Powered by The Guardian (open-platform.theguardian.com).',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    article_id: z
      .string()
      .describe(
        'Use the exact id from guardian_search_articles or guardian_browse_content, or an article URL on theguardian.com or www.theguardian.com.',
      ),
  }),

  output: z.object({
    id: z.string().describe('Article ID (path slug).'),
    type: z.string().describe('Content type (typically "article").'),
    section_id: z.string().describe('Section identifier.'),
    section_name: z.string().describe('Human-readable section name.'),
    published_date: z
      .string()
      .describe(
        'Guardian web publication timestamp (ISO 8601 UTC). This can advance for a live blog.',
      ),
    first_published_date: z
      .string()
      .optional()
      .describe('First publication timestamp when available (ISO 8601 UTC).'),
    last_modified: z
      .string()
      .optional()
      .describe('Most recent modification timestamp when available (ISO 8601 UTC).'),
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
        'Complete article body text (HTML stripped), without a word limit. If unavailable, the placeholder identifies the content type.',
      ),
    truncated: z
      .boolean()
      .describe('False: single-article retrieval returns the complete available body.'),
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
    tags: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe('Exact Guardian tag ID. Use as tag in search or tag_id in browse.'),
            type: ArticleTagTypeSchema.describe('Guardian tag type.'),
            name: z.string().describe('Guardian tag display name.'),
          })
          .describe('A topic, series, or tone tag attached to the article.'),
      )
      .describe('Topic and editorial tags.'),
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
        'Use the exact article_id returned by guardian_search_articles or guardian_browse_content.',
      thrownBy: 'service',
    },
    {
      reason: 'request_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The Guardian API returned HTTP 400.',
      recovery: 'Use the exact article_id returned by guardian_search_articles.',
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
      recovery: 'Retry after a short delay.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching Guardian article');

    const article = await getGuardianService().getContent(input.article_id, ctx);

    // body is required in the output schema — supply a placeholder when absent (non-article types)
    const body = article.body ?? `(Body not available for this content type: ${article.type}.)`;

    return {
      ...article,
      body,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${literal(result.headline || result.id).replaceAll('\\\n', '&#10;')}`);
    lines.push('');
    lines.push(`**ID:** ${literal(result.id)}`);
    lines.push(
      `**Section:** ${literal(result.section_name)} (${literal(result.section_id)}) | **Published:** ${literal(result.published_date)} | **Type:** ${literal(result.type)}`,
    );
    if (result.first_published_date !== undefined)
      lines.push(`**First published:** ${literal(result.first_published_date)}`);
    if (result.last_modified !== undefined)
      lines.push(`**Last modified:** ${literal(result.last_modified)}`);
    if (result.byline !== undefined) lines.push(`**By:** ${literal(result.byline)}`);
    if (result.pillar_id !== undefined) {
      lines.push(
        `**Pillar:** ${literal(result.pillar_name ?? result.pillar_id)} (${literal(result.pillar_id)})`,
      );
    } else if (result.pillar_name !== undefined) {
      lines.push(`**Pillar:** ${literal(result.pillar_name)}`);
    }
    if (result.word_count != null) lines.push(`**Word count:** ${result.word_count}`);
    if (result.contributors.length > 0) {
      const contribs = result.contributors
        .map((c) => `${literal(c.name)} (${literal(c.id)})`)
        .join(', ');
      lines.push(`**Contributors:** ${contribs}`);
    }
    if (result.tags.length > 0) {
      const tags = result.tags
        .map((tag) => `${literal(tag.name)} (${literal(tag.type)}, ${literal(tag.id)})`)
        .join(', ');
      lines.push(`**Tags:** ${tags}`);
    }
    lines.push(`**URL:** ${markdownLink(result.web_url, result.web_url)}`);
    if (result.thumbnail !== undefined)
      lines.push(`**Thumbnail:** ${markdownImage('Article thumbnail', result.thumbnail)}`);
    if (result.standfirst !== undefined) {
      lines.push('', `**Standfirst:** ${literal(result.standfirst)}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(literal(result.body));
    lines.push('');
    lines.push(`**Truncated:** ${result.truncated}`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
