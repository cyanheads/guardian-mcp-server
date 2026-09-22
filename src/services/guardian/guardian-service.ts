/**
 * @fileoverview Guardian Open Platform API service — HTTP client, HTML stripping, word-count
 * truncation, and response normalization for all three tools.
 * @module services/guardian/guardian-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  NormalizedArticle,
  NormalizedSearchResult,
  NormalizedSection,
  NormalizedSectionsResult,
  NormalizedTag,
  NormalizedTagsResult,
  RawContentItem,
  RawSearchResponse,
  RawSectionsResponse,
  RawSingleContent,
  RawSingleResponse,
  RawTag,
  RawTagsResponse,
} from './types.js';

const BASE_URL = 'https://content.guardianapis.com';
const TIMEOUT_MS = 10_000;
const WORD_LIMIT = 2_000;

/** Shared show-fields param for all article-returning endpoints. */
const SHOW_FIELDS = 'body,headline,byline,thumbnail,wordcount,standfirst';

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

/** Named character references stripHtml decodes. A Map, so a reference name never reaches Object.prototype. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['nbsp', ' '],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
]);

const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Decode one character reference; an unknown name or out-of-range code point stays literal. */
function decodeEntity(match: string, ref: string): string {
  if (!ref.startsWith('#')) return NAMED_ENTITIES.get(ref) ?? match;
  const codePoint = /^#x/i.test(ref)
    ? Number.parseInt(ref.slice(2), 16)
    : Number.parseInt(ref.slice(1), 10);
  return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
}

/** Strip HTML tags and decode entities from a string, each character reference exactly once. */
function stripHtml(html: string): string {
  return (
    html
      // Remove script/style blocks entirely
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
      // Replace block-level elements with newlines
      .replace(/<\/(p|div|li|h[1-6]|blockquote|figure|aside|section|article|br)>/gi, '\n')
      // Replace <br> self-closing
      .replace(/<br\s*\/?>/gi, '\n')
      // Strip remaining tags
      .replace(/<[^>]+>/g, '')
      // Decode entities in one pass, so an `&` a decode produces is never decoded again
      .replace(ENTITY_PATTERN, decodeEntity)
      // Collapse excess whitespace / blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Body truncation
// ---------------------------------------------------------------------------

/** Truncate body text at WORD_LIMIT words, appending a note with the article ID. */
function truncateBody(text: string, articleId: string): { body: string; truncated: boolean } {
  const words = text.split(/\s+/);
  if (words.length <= WORD_LIMIT) {
    return { body: text, truncated: false };
  }
  const truncated = words.slice(0, WORD_LIMIT).join(' ');
  return {
    body:
      truncated +
      `\n\n[Article truncated at 2,000 words. Use guardian_get_article with id "${articleId}" to retrieve the full text.]`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeContributors(tags?: RawTag[]): Array<{ id: string; name: string }> {
  if (!tags) return [];
  return tags.filter((t) => t.type === 'contributor').map((t) => ({ id: t.id, name: t.webTitle }));
}

function normalizeArticle(raw: RawContentItem | RawSingleContent): NormalizedArticle {
  const fields = raw.fields ?? {};

  const rawHeadlineStr = fields.headline ?? '';
  const headline = rawHeadlineStr ? stripHtml(rawHeadlineStr) : '';
  const standfirst = fields.standfirst ? stripHtml(fields.standfirst) : undefined;
  const byline = fields.byline ? stripHtml(fields.byline) : undefined;
  const strippedBody = fields.body ? stripHtml(fields.body) : undefined;
  const word_count = fields.wordcount
    ? Number.parseInt(fields.wordcount, 10) || undefined
    : undefined;

  let body: string | undefined;
  let truncated = false;
  if (strippedBody) {
    const result = truncateBody(strippedBody, raw.id);
    body = result.body;
    truncated = result.truncated;
  }

  return {
    id: raw.id,
    type: raw.type,
    section_id: raw.sectionId,
    section_name: raw.sectionName,
    published_date: raw.webPublicationDate,
    headline,
    ...(standfirst !== undefined && { standfirst }),
    ...(byline !== undefined && { byline }),
    web_url: raw.webUrl,
    ...(fields.thumbnail !== undefined && { thumbnail: fields.thumbnail }),
    ...(word_count !== undefined && { word_count }),
    ...(body !== undefined && { body }),
    truncated,
    contributors: normalizeContributors(raw.tags),
    ...(raw.pillarId !== undefined && { pillar_id: raw.pillarId }),
    ...(raw.pillarName !== undefined && { pillar_name: raw.pillarName }),
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Build a URL with query params, always injecting api-key and format. */
function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('api-key', getServerConfig().apiKey);
  url.searchParams.set('format', 'json');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Detect and throw on HTML error-page responses from the API. */
function assertNotHtmlPage(text: string): void {
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable(
      'Guardian API returned an HTML page instead of JSON — the service may be temporarily unavailable.',
    );
  }
}

/** Redact the api-key query parameter from URLs in error messages. */
function redactApiKey(message: string): string {
  return message.replace(/([?&]api-key=)[^&\s"]+/gi, '$1[REDACTED]');
}

/**
 * Annotate a caught McpError from fetchWithTimeout with a contract reason so
 * tool handlers get `data.reason` populated. Resolves the calling tool's
 * declared recovery hint via `ctx.recoveryFor` ({} when the reason isn't in
 * the caller's contract). Always redacts the API key from the message before
 * rethrowing, even when the error already carries a reason.
 */
function annotateHttpError(
  err: unknown,
  ctx: Context,
  opts: { notFoundReason?: string } = {},
): never {
  if (!(err instanceof McpError)) throw err;

  const safeMessage = redactApiKey(err.message);

  // Already has a reason — rethrow with redacted message only
  if (typeof (err.data as Record<string, unknown> | undefined)?.reason === 'string') {
    throw new McpError(err.code, safeMessage, err.data as Record<string, unknown> | undefined);
  }

  const status = (err.data as Record<string, unknown> | undefined)?.statusCode as
    | number
    | undefined;

  if (status === 401) {
    throw new McpError(JsonRpcErrorCode.Unauthorized, safeMessage, {
      ...(err.data as object | undefined),
      reason: 'unauthorized',
      ...ctx.recoveryFor('unauthorized'),
    });
  }
  if (status === 404 && opts.notFoundReason) {
    throw new McpError(JsonRpcErrorCode.NotFound, safeMessage, {
      ...(err.data as object | undefined),
      reason: opts.notFoundReason,
      ...ctx.recoveryFor(opts.notFoundReason),
    });
  }
  // All other non-OK statuses map to api_error
  throw new McpError(err.code, safeMessage, {
    ...(err.data as object | undefined),
    reason: 'api_error',
    ...ctx.recoveryFor('api_error'),
  });
}

// ---------------------------------------------------------------------------
// GuardianService
// ---------------------------------------------------------------------------

export class GuardianService {
  /** Full-text search across the Guardian archive. */
  search(
    params: {
      query: string;
      section?: string;
      tag?: string;
      contributor?: string;
      from_date?: string;
      to_date?: string;
      order_by?: string;
      page?: number;
      page_size?: number;
    },
    ctx: Context,
  ): Promise<NormalizedSearchResult> {
    // Build tag param: merge tag + contributor (contributor is a tag under profile/ namespace)
    let tagParam: string | undefined = params.tag;
    if (params.contributor) {
      tagParam = tagParam ? `${tagParam},${params.contributor}` : params.contributor;
    }

    const url = buildUrl('/search', {
      q: params.query,
      'show-fields': SHOW_FIELDS,
      'show-tags': 'contributor',
      section: params.section,
      tag: tagParam,
      'from-date': params.from_date,
      'to-date': params.to_date,
      'order-by': params.order_by ?? 'relevance',
      page: params.page ?? 1,
      'page-size': params.page_size ?? 10,
    });

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, { signal: ctx.signal });
        const text = await response.text();
        assertNotHtmlPage(text);
        const data = JSON.parse(text) as RawSearchResponse;
        const r = data.response;

        return {
          total: r.total,
          page: r.currentPage,
          pages: r.pages,
          page_size: r.results.length,
          order_by: r.orderBy ?? params.order_by ?? 'relevance',
          results: r.results.map(normalizeArticle),
        };
      },
      {
        operation: 'GuardianService.search',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    ).catch((err) => annotateHttpError(err, ctx));
  }

  /** Fetch a single article by its path-slug ID. */
  getContent(articleId: string, ctx: Context): Promise<NormalizedArticle> {
    const url = buildUrl(`/${articleId}`, {
      'show-fields': SHOW_FIELDS,
      'show-tags': 'contributor',
    });

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, { signal: ctx.signal });
        const text = await response.text();
        assertNotHtmlPage(text);
        const data = JSON.parse(text) as RawSingleResponse;
        return normalizeArticle(data.response.content);
      },
      {
        operation: 'GuardianService.getContent',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    ).catch((err) => annotateHttpError(err, ctx, { notFoundReason: 'not_found' }));
  }

  /** Fetch latest content from a section ID. */
  getSectionContent(
    sectionId: string,
    pageParams: { page?: number; page_size?: number },
    ctx: Context,
  ): Promise<NormalizedSearchResult> {
    const url = buildUrl(`/${sectionId}`, {
      'show-fields': SHOW_FIELDS,
      'show-tags': 'contributor',
      page: pageParams.page ?? 1,
      'page-size': pageParams.page_size ?? 10,
    });

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, { signal: ctx.signal });
        const text = await response.text();
        assertNotHtmlPage(text);
        const data = JSON.parse(text) as RawSearchResponse;
        const r = data.response;

        return {
          total: r.total,
          page: r.currentPage,
          pages: r.pages,
          page_size: r.results.length,
          order_by: 'newest', // section endpoint always returns newest first
          results: r.results.map(normalizeArticle),
        };
      },
      {
        operation: 'GuardianService.getSectionContent',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    ).catch((err) => annotateHttpError(err, ctx, { notFoundReason: 'section_not_found' }));
  }

  /** Fetch all Guardian sections, optionally filtering by query. */
  getSections(query: string | undefined, ctx: Context): Promise<NormalizedSectionsResult> {
    const url = buildUrl('/sections', { q: query });

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, { signal: ctx.signal });
        const text = await response.text();
        assertNotHtmlPage(text);
        const data = JSON.parse(text) as RawSectionsResponse;
        const r = data.response;

        const sections: NormalizedSection[] = r.results.map((s) => ({
          id: s.id,
          name: s.webTitle,
          web_url: s.webUrl,
        }));

        return { total: r.total, sections };
      },
      {
        operation: 'GuardianService.getSections',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    ).catch((err) => annotateHttpError(err, ctx));
  }

  /** Search the Guardian tag taxonomy. */
  getTags(
    params: {
      query?: string;
      tag_type?: string;
      section?: string;
      page?: number;
      page_size?: number;
    },
    ctx: Context,
  ): Promise<NormalizedTagsResult> {
    const url = buildUrl('/tags', {
      q: params.query,
      type: params.tag_type,
      section: params.section,
      page: params.page ?? 1,
      'page-size': params.page_size ?? 10,
    });

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, { signal: ctx.signal });
        const text = await response.text();
        assertNotHtmlPage(text);
        const data = JSON.parse(text) as RawTagsResponse;
        const r = data.response;

        const tags: NormalizedTag[] = r.results.map((t) => ({
          id: t.id,
          type: t.type,
          name: t.webTitle,
          web_url: t.webUrl,
          ...(t.sectionId != null && { section_id: t.sectionId }),
          ...(t.sectionName != null && { section_name: t.sectionName }),
        }));

        return {
          total: r.total,
          page: r.currentPage,
          pages: r.pages,
          tags,
        };
      },
      {
        operation: 'GuardianService.getTags',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    ).catch((err) => annotateHttpError(err, ctx));
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: GuardianService | undefined;

export function initGuardianService(): void {
  _service = new GuardianService();
}

export function getGuardianService(): GuardianService {
  if (!_service) {
    throw new Error('GuardianService not initialized — call initGuardianService() in setup()');
  }
  return _service;
}
