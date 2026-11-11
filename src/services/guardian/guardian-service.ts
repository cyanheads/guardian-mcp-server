/**
 * @fileoverview Guardian Open Platform API service — HTTP client, HTML stripping, word-count
 * truncation, and response normalization for all three tools.
 * @module services/guardian/guardian-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  ArticleTagTypeSchema,
  type NormalizedArticle,
  type NormalizedArticleDetail,
  type NormalizedSearchResult,
  type NormalizedSection,
  type NormalizedSectionsResult,
  type NormalizedTag,
  type NormalizedTagsResult,
  type RawContentItem,
  type RawSearchResponse,
  RawSectionContentResponseSchema,
  type RawSectionsResponse,
  RawSingleResponseSchema,
  type RawTagsResponse,
} from './types.js';

const BASE_URL = 'https://content.guardianapis.com';
const TIMEOUT_MS = 10_000;
const WORD_LIMIT = 2_000;

/** Shared show-fields param for all article-returning endpoints. */
const METADATA_FIELDS = 'headline,byline,thumbnail,wordcount,standfirst';
const SHOW_FIELDS = `body,${METADATA_FIELDS}`;

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
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'figure',
  'aside',
  'section',
  'article',
]);

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
  const output: string[] = [];
  const tagStart = /<(?:!--|[!?]|\/?([a-z][^\t\n\f\r /<>"'=]*)(?=[\t\n\f\r />]))/gi;
  const commentEnd = /--!?>/g;
  let tableDepth = 0;
  let row: string[] = [];
  let cell: string[] | undefined;
  let inCaption = false;
  let offset = 0;

  function finishCell(): void {
    if (!cell) return;
    row.push(cell.join('').replace(/\s+/g, ' ').trim());
    cell = undefined;
  }

  function finishRow(): void {
    finishCell();
    if (row.length === 0) return;
    output.push(row.join(' | '), '\n');
    row = [];
  }

  for (let tag = tagStart.exec(html); tag; tag = tagStart.exec(html)) {
    const destination = tableDepth && !inCaption ? cell : output;
    if (tag[0] === '<!--') {
      if (tag.index > offset) destination?.push(html.slice(offset, tag.index));
      commentEnd.lastIndex = tagStart.lastIndex;
      offset = commentEnd.exec(html) ? commentEnd.lastIndex : html.length;
      tagStart.lastIndex = offset;
      continue;
    }

    let end = tagStart.lastIndex;
    // Skip quoted attributes before testing for a tag boundary.
    while (end < html.length && html[end] !== '>' && html[end] !== '<') {
      const character = html[end];
      if (character === '"' || character === "'") {
        const quoteEnd = html.indexOf(character, end + 1);
        end = quoteEnd === -1 ? html.length : quoteEnd + 1;
      } else {
        end++;
      }
    }
    tagStart.lastIndex = end;
    if (html[end] !== '>') continue;

    if (tag.index > offset) destination?.push(html.slice(offset, tag.index));
    offset = end + 1;
    tagStart.lastIndex = offset;

    const name = tag[1]?.toLowerCase();
    const closing = tag[0][1] === '/';
    const cellBoundary = name === 'th' || name === 'td';
    const rowBoundary =
      name === 'tr' || (closing && (name === 'thead' || name === 'tbody' || name === 'tfoot'));
    if (!closing && (name === 'script' || name === 'style')) {
      const rawEnd =
        name === 'script' ? /<\/script[\t\n\f\r ]*\/?>/gi : /<\/style[\t\n\f\r ]*\/?>/gi;
      rawEnd.lastIndex = offset;
      offset = rawEnd.exec(html) ? rawEnd.lastIndex : html.length;
      tagStart.lastIndex = offset;
    } else if (name === 'table') {
      if (!closing) {
        destination?.push('\n');
        tableDepth++;
      } else if (tableDepth > 0) {
        if (tableDepth === 1) {
          finishRow();
          inCaption = false;
        }
        tableDepth--;
        (tableDepth === 0 ? output : destination)?.push('\n');
      }
    } else if (tableDepth === 1 && name === 'caption') {
      inCaption = !closing;
      if (closing) output.push('\n');
    } else if (tableDepth === 1 && cellBoundary) {
      finishCell();
      if (!closing) cell = [];
    } else if (tableDepth === 1 && rowBoundary) {
      finishRow();
    } else if (tableDepth > 1 && (cellBoundary || rowBoundary || name === 'caption')) {
      // Nested tables contribute text to the outer cell without changing its columns.
      destination?.push(' ');
    } else if (name === 'br') {
      destination?.push('\n');
    } else if (name !== undefined && BLOCK_TAGS.has(name)) {
      const last = destination?.at(-1);
      if (closing || (last && !last.endsWith('\n'))) destination?.push('\n');
    }
  }
  if (tableDepth === 0) output.push(html.slice(offset));
  return output
    .join('')
    .replace(ENTITY_PATTERN, decodeEntity)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Body truncation
// ---------------------------------------------------------------------------

/** Truncate body text at WORD_LIMIT words, appending a note with the article ID. */
function truncateBody(text: string, articleId: string): { body: string; truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const word of text.matchAll(/\S+/g)) {
    if (word[0] === '|') continue;
    if (count === WORD_LIMIT) {
      return {
        body: `${text.slice(0, end)}\n\n[Article truncated at 2,000 words. Use guardian_get_article with article_id "${articleId}" to retrieve the full text.]`,
        truncated: true,
      };
    }
    count++;
    end = word.index + word[0].length;
  }
  return { body: text, truncated: false };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeContributors(tags: RawContentItem['tags']): Array<{ id: string; name: string }> {
  if (!tags) return [];
  return tags.filter((t) => t.type === 'contributor').map((t) => ({ id: t.id, name: t.webTitle }));
}

function normalizeArticle(
  raw: RawContentItem,
  bodyMode: 'preview' | 'full' | 'omit',
): NormalizedArticle {
  const fields = raw.fields ?? {};

  const headline = fields.headline ? stripHtml(fields.headline) : '';
  const standfirst = fields.standfirst ? stripHtml(fields.standfirst) : undefined;
  const byline = fields.byline ? stripHtml(fields.byline) : undefined;
  const strippedBody = bodyMode !== 'omit' && fields.body ? stripHtml(fields.body) : undefined;
  const word_count = fields.wordcount
    ? Number.parseInt(fields.wordcount, 10) || undefined
    : undefined;

  const preview =
    strippedBody && bodyMode === 'preview' ? truncateBody(strippedBody, raw.id) : undefined;
  const body = preview?.body ?? strippedBody;

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
    ...(body && { body }),
    truncated: preview?.truncated ?? false,
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

/** A wrong endpoint shape or an unusable identifier is a nonretryable lookup miss. */
function lookupMiss(reason: 'not_found' | 'section_not_found'): McpError {
  const message =
    reason === 'not_found'
      ? 'Guardian article not found. Use the exact article_id returned by guardian_search_articles.'
      : 'Guardian section not found. Verify the section_id.';
  return new McpError(JsonRpcErrorCode.NotFound, message, { reason, retryable: false });
}

/** Decode a completed lookup response, mapping malformed JSON to a nonretryable miss. */
function parseLookupJson(text: string, reason: 'not_found' | 'section_not_found'): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw lookupMiss(reason);
  }
}

/** Encode bare IDs as path segments and use only the pathname from Guardian web URLs. */
function lookupPath(id: string, reason: 'not_found' | 'section_not_found'): string {
  if (id.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(id)) {
    const url = URL.parse(id);
    if (
      reason !== 'not_found' ||
      !url ||
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      (url.hostname !== 'www.theguardian.com' && url.hostname !== 'theguardian.com') ||
      url.pathname === '/'
    )
      throw lookupMiss(reason);
    return url.pathname;
  }

  const segments = id.replace(/^\//, '').split('/');
  if (!id || segments.some((segment) => segment === '.' || segment === '..')) {
    throw lookupMiss(reason);
  }
  return `/${segments.map((segment) => encodeURIComponent(segment.toWellFormed())).join('/')}`;
}

/** Read the response body inside the retry attempt, including checks for HTML error pages. */
async function fetchGuardianText(url: string, ctx: Context): Promise<string> {
  const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, { signal: ctx.signal });
  const text = await response.text();
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable(
      'Guardian API returned an HTML page instead of JSON — the service may be temporarily unavailable.',
    );
  }
  return text;
}

/** Redact the api-key query parameter from URLs in error messages. */
function redactApiKey(message: string): string {
  return message.replace(/([?&]api-key=)[^&\s"]+/gi, '$1[REDACTED]');
}

/**
 * Annotate a caught McpError from fetchWithTimeout with a contract reason so
 * tool handlers get `data.reason` populated. The framework fills the calling
 * tool's declared recovery hint. Always redacts the API key from the message before
 * rethrowing, even when the error already carries a reason.
 */
function annotateHttpError(
  err: unknown,
  opts: { notFoundReason?: string; badRequestHint?: string } = {},
): never {
  if (!(err instanceof McpError)) throw err;
  const data = err.data;
  const status = data?.status ?? data?.statusCode;
  if (typeof status !== 'number') {
    const reason =
      data?.reason ??
      (err.code === JsonRpcErrorCode.ServiceUnavailable
        ? 'api_error'
        : err.code === JsonRpcErrorCode.Timeout
          ? 'api_timeout'
          : undefined);
    throw new McpError(err.code, redactApiKey(err.message), {
      ...data,
      ...(reason !== undefined && { reason }),
      ...(data?.reason === undefined && reason !== undefined && { retryable: true }),
    });
  }
  const families: Partial<Record<JsonRpcErrorCode, string>> = {
    [JsonRpcErrorCode.InvalidParams]: 'request_rejected',
    [JsonRpcErrorCode.Unauthorized]: 'unauthorized',
    [JsonRpcErrorCode.Forbidden]: 'access_denied',
    [JsonRpcErrorCode.NotFound]: 'request_not_found',
    [JsonRpcErrorCode.InvalidRequest]: 'invalid_request',
    [JsonRpcErrorCode.Conflict]: 'request_conflict',
    [JsonRpcErrorCode.ValidationError]: 'validation_failed',
    [JsonRpcErrorCode.Timeout]: 'api_timeout',
    [JsonRpcErrorCode.RateLimited]: 'rate_limited',
    [JsonRpcErrorCode.ServiceUnavailable]: 'api_error',
  };
  const reason =
    typeof data?.reason === 'string'
      ? data.reason
      : status === 404 && opts.notFoundReason
        ? opts.notFoundReason
        : status === 501
          ? 'api_unsupported'
          : families[err.code];
  const retryable =
    status !== 501 &&
    [
      JsonRpcErrorCode.Timeout,
      JsonRpcErrorCode.RateLimited,
      JsonRpcErrorCode.ServiceUnavailable,
    ].includes(err.code);
  const message =
    reason === 'not_found'
      ? 'Guardian article not found. Verify the article_id.'
      : reason === 'section_not_found'
        ? 'Guardian section not found. Verify the section_id.'
        : status === 401
          ? 'Guardian API authentication failed. Check GUARDIAN_API_KEY.'
          : status === 403
            ? 'Guardian API access denied. Check the API key permissions and access limits.'
            : retryable
              ? `Guardian API temporarily unavailable (HTTP ${status}).`
              : status === 501
                ? 'Guardian API does not support this request (HTTP 501).'
                : status === 400 && opts.badRequestHint
                  ? `Guardian API rejected the request (HTTP 400). ${opts.badRequestHint}`
                  : `Guardian API rejected the request (HTTP ${status}). Check the parameters and requested page.`;
  const body = data?.body ?? data?.responseBody;
  // Carry the framework's server-only field marker without exposing extra fetch diagnostics.
  const metadata = Object.fromEntries(
    Object.getOwnPropertySymbols(data ?? {}).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(data ?? {}, key)?.value,
    ]),
  );
  throw new McpError(err.code, message, {
    ...metadata,
    status,
    ...(typeof body === 'string' && {
      body: redactApiKey(body).replaceAll(getServerConfig().apiKey, '[REDACTED]'),
    }),
    ...(data?.retryAfter !== undefined && { retryAfter: data.retryAfter }),
    ...(data?.retryAttempts !== undefined && { retryAttempts: data.retryAttempts }),
    reason,
    retryable,
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
      include_body?: boolean;
    },
    ctx: Context,
  ): Promise<NormalizedSearchResult> {
    // Build tag param: merge tag + contributor (contributor is a tag under profile/ namespace)
    const contributor =
      params.contributor && /^[a-z0-9][a-z0-9_-]*$/i.test(params.contributor)
        ? `profile/${params.contributor}`
        : params.contributor;
    const tagParam = [params.tag, contributor].filter(Boolean).join(',');
    const query = params.query.trim() ? params.query : '';
    const requestedOrder = params.order_by ?? 'relevance';
    const order = !query && requestedOrder === 'relevance' ? 'newest' : requestedOrder;
    const includeBody = params.include_body !== false;

    const url = buildUrl('/search', {
      q: query,
      'show-fields': includeBody ? SHOW_FIELDS : METADATA_FIELDS,
      'show-tags': 'contributor',
      section: params.section,
      tag: tagParam,
      'from-date': params.from_date,
      'to-date': params.to_date,
      'order-by': order,
      page: params.page ?? 1,
      'page-size': params.page_size ?? 10,
    });

    return withRetry(
      async () => {
        const text = await fetchGuardianText(url, ctx);
        const data = JSON.parse(text) as RawSearchResponse;
        const r = data.response;

        return {
          total: r.total,
          page: r.currentPage,
          pages: r.pages,
          page_size: r.results.length,
          order_by: r.orderBy ?? order,
          results: r.results.map((raw) => normalizeArticle(raw, includeBody ? 'preview' : 'omit')),
        };
      },
      {
        operation: 'GuardianService.search',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    ).catch((err) =>
      annotateHttpError(err, {
        badRequestHint:
          'Check the filters and use an earlier page. Guardian can reject paging past 38,000 results even within the reported page count.',
      }),
    );
  }

  /** Fetch a single article by its ID or Guardian web URL. */
  async getContent(articleId: string, ctx: Context): Promise<NormalizedArticleDetail> {
    const url = buildUrl(lookupPath(articleId, 'not_found'), {
      'show-fields': `${SHOW_FIELDS},firstPublicationDate,lastModified`,
      'show-tags': 'keyword,series,tone,contributor',
    });

    const text = await withRetry(() => fetchGuardianText(url, ctx), {
      operation: 'GuardianService.getContent',
      context: ctx,
      baseDelayMs: 500,
      signal: ctx.signal,
    }).catch((err) =>
      annotateHttpError(err, {
        notFoundReason: 'not_found',
        badRequestHint: 'Use the exact article_id returned by guardian_search_articles.',
      }),
    );

    const data = RawSingleResponseSchema.safeParse(parseLookupJson(text, 'not_found'));
    if (!data.success) throw lookupMiss('not_found');
    const { content } = data.data.response;
    const { firstPublicationDate, lastModified } = content.fields ?? {};
    const tags: NormalizedArticleDetail['tags'] = [];
    for (const tag of content.tags ?? []) {
      const type = ArticleTagTypeSchema.safeParse(tag.type);
      if (type.success) tags.push({ id: tag.id, type: type.data, name: tag.webTitle });
    }
    return {
      ...normalizeArticle(content, 'full'),
      tags,
      ...(firstPublicationDate && { first_published_date: firstPublicationDate }),
      ...(lastModified && { last_modified: lastModified }),
    };
  }

  /** Fetch latest content from a section ID. */
  async getSectionContent(
    sectionId: string,
    pageParams: { page?: number; page_size?: number; include_body?: boolean },
    ctx: Context,
  ): Promise<NormalizedSearchResult> {
    const includeBody = pageParams.include_body !== false;
    const url = buildUrl(lookupPath(sectionId, 'section_not_found'), {
      'show-fields': includeBody ? SHOW_FIELDS : METADATA_FIELDS,
      'show-tags': 'contributor',
      page: pageParams.page ?? 1,
      'page-size': pageParams.page_size ?? 10,
    });

    const text = await withRetry(() => fetchGuardianText(url, ctx), {
      operation: 'GuardianService.getSectionContent',
      context: ctx,
      baseDelayMs: 500,
      signal: ctx.signal,
    }).catch((err) =>
      annotateHttpError(err, {
        notFoundReason: 'section_not_found',
        badRequestHint:
          'Use an earlier page or a narrower section. Guardian can reject paging past 38,000 results even within the reported page count.',
      }),
    );

    const data = RawSectionContentResponseSchema.safeParse(
      parseLookupJson(text, 'section_not_found'),
    );
    if (!data.success) throw lookupMiss('section_not_found');
    const r = data.data.response;
    return {
      total: r.total,
      page: r.currentPage,
      pages: r.pages,
      page_size: r.results.length,
      order_by: 'newest',
      results: r.results.map((raw) => normalizeArticle(raw, includeBody ? 'preview' : 'omit')),
    };
  }

  /** Fetch all Guardian sections, optionally filtering by query. */
  getSections(query: string | undefined, ctx: Context): Promise<NormalizedSectionsResult> {
    const url = buildUrl('/sections', { q: query });

    return withRetry(
      async () => {
        const text = await fetchGuardianText(url, ctx);
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
    ).catch((err) => annotateHttpError(err));
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
        const text = await fetchGuardianText(url, ctx);
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
    ).catch((err) =>
      annotateHttpError(err, {
        badRequestHint:
          'Use an earlier page or narrow by query, tag_type, or section_id. Guardian can reject paging past 38,000 results even within the reported page count.',
      }),
    );
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
