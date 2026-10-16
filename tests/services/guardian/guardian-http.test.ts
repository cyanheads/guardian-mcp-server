/**
 * @fileoverview Guardian HTTP classification through the real fetch and retry helpers.
 * @module tests/services/guardian/guardian-http.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardianBrowseContent } from '@/mcp-server/tools/definitions/guardian-browse-content.tool.js';
import { guardianGetArticle } from '@/mcp-server/tools/definitions/guardian-get-article.tool.js';
import { guardianSearchArticles } from '@/mcp-server/tools/definitions/guardian-search-articles.tool.js';
import { GuardianService, initGuardianService } from '@/services/guardian/guardian-service.js';

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => ({ apiKey: 'test-key' }) }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HTTP classification after retries', () => {
  it.each(['html', 'network'] as const)(
    'retains declared recovery for a reasonless %s service failure',
    async (kind) => {
      vi.useFakeTimers();
      initGuardianService();
      const fetch = vi.fn(async () => {
        if (kind === 'network') throw new TypeError('connection reset');
        return new Response('<!DOCTYPE html><html>Unavailable</html>');
      });
      vi.stubGlobal('fetch', fetch);
      const pending = runToolContract(guardianSearchArticles, { query: 'test' });
      await vi.runAllTimersAsync();
      const result = await pending;
      const recovery = guardianSearchArticles.errors?.find(
        (entry) => entry.reason === 'api_error',
      )?.recovery;
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            data: { reason: 'api_error', retryable: true, recovery: { hint: recovery } },
          },
        },
      });
      expect(result.content).toEqual([
        { type: 'text', text: expect.stringContaining(`Recovery: ${recovery}`) },
      ]);
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    [400, JsonRpcErrorCode.InvalidParams, 'request_rejected', false, 1],
    [401, JsonRpcErrorCode.Unauthorized, 'unauthorized', false, 1],
    [403, JsonRpcErrorCode.Forbidden, 'access_denied', false, 1],
    [422, JsonRpcErrorCode.ValidationError, 'validation_failed', false, 1],
    [408, JsonRpcErrorCode.Timeout, 'api_timeout', true, 4],
    [429, JsonRpcErrorCode.RateLimited, 'rate_limited', true, 4],
    [501, JsonRpcErrorCode.ServiceUnavailable, 'api_unsupported', false, 1],
    [503, JsonRpcErrorCode.ServiceUnavailable, 'api_error', true, 4],
  ] as const)(
    'normalizes HTTP %i without changing attempts',
    async (status, code, reason, retryable, attempts) => {
      vi.useFakeTimers();
      const fetch = vi.fn(async () => new Response('{"message":"request failed"}', { status }));
      vi.stubGlobal('fetch', fetch);
      initGuardianService();
      const pending = runToolContract(guardianSearchArticles, { query: 'test' });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error;
      expect(error).toMatchObject({ code, data: { status, reason, retryable } });
      expect(error).toHaveProperty('data.body', '{"message":"request failed"}');
      expect(error).not.toHaveProperty('data.statusCode');
      expect(error).not.toHaveProperty('data.responseBody');
      expect(error).not.toHaveProperty('data.rootCause');
      expect(error).not.toHaveProperty('data.url');
      const messages: Record<number, string> = {
        400: 'Guardian API rejected the request (HTTP 400). Check the parameters and requested page.',
        401: 'Guardian API authentication failed. Check GUARDIAN_API_KEY.',
        403: 'Guardian API access denied. Check the API key permissions and access limits.',
        422: 'Guardian API rejected the request (HTTP 422). Check the parameters and requested page.',
        408: 'Guardian API temporarily unavailable (HTTP 408).',
        429: 'Guardian API temporarily unavailable (HTTP 429).',
        501: 'Guardian API does not support this request (HTTP 501).',
        503: 'Guardian API temporarily unavailable (HTTP 503).',
      };
      expect(error).toHaveProperty('message', messages[status]);
      const recovery = guardianSearchArticles.errors?.find(
        (entry) => entry.reason === reason,
      )?.recovery;
      expect(error.data.recovery.hint).toBe(recovery);
      expect(result.content).toEqual([
        {
          type: 'text',
          text: expect.stringContaining(`Recovery: ${recovery}`),
        },
      ]);
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain(retryable ? '· retryable' : '· not retryable');
      if (attempts > 1) expect(error).toHaveProperty('data.retryAttempts', attempts);
      expect(JSON.stringify(error)).not.toContain('test-key');
      expect(fetch).toHaveBeenCalledTimes(attempts);
    },
  );

  it.each(['article', 'section'] as const)('keeps domain-specific %s 404 reasons', async (kind) => {
    const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const service = new GuardianService();
    const pending =
      kind === 'article'
        ? service.getContent('world/test', createMockContext())
        : service.getSectionContent('world', {}, createMockContext());
    await expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining(`Guardian ${kind} not found`),
      data: { reason: kind === 'article' ? 'not_found' : 'section_not_found', retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops retries when the caller cancels during backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const pending = new GuardianService()
      .search({ query: 'test' }, createMockContext({ signal: controller.signal }))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('article preview and complete retrieval surfaces', () => {
  it('identifies every mixed-page article state on both surfaces in all preview modes', async () => {
    initGuardianService();
    const articles = [
      { id: 'world/long', fields: { body: 'long '.repeat(2001).trim() } },
      { id: 'world/short', fields: { body: 'Short body.' } },
      { id: 'world/missing', fields: {} },
    ].map((article) => ({
      type: 'article',
      sectionId: 'world',
      sectionName: 'World',
      webPublicationDate: '2024-01-01T00:00:00Z',
      webUrl: `https://www.theguardian.com/${article.id}`,
      tags: [],
      ...article,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          response: { total: 3, currentPage: 1, pages: 1, results: articles },
        }),
      ),
    );
    for (const [definition, input] of [
      [guardianSearchArticles, { query: 'test' }],
      [guardianBrowseContent, { mode: 'section_latest', section_id: 'world' }],
      [guardianBrowseContent, { mode: 'tag_latest', tag_id: 'world/ukraine' }],
    ] as const) {
      const result = await runToolContract(
        definition as typeof guardianSearchArticles,
        input as never,
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        results: [
          { id: 'world/long', truncated: true },
          { id: 'world/short', body: 'Short body.', truncated: false },
          { id: 'world/missing', truncated: false },
        ],
      });
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      const records = text.split('## ').slice(1);
      expect(records).toHaveLength(3);
      for (const [index, id] of ['world/long', 'world/short', 'world/missing'].entries()) {
        expect(records[index]).toContain(id);
        expect(records[index]?.toLowerCase()).toContain(`**truncated:** ${index === 0}`);
      }
    }
  });

  it.each([0, 20, 2000, 2001])('preserves both surfaces for a %i-word article', async (count) => {
    initGuardianService();
    const body = Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
    const article = {
      id: 'world/test',
      type: 'article',
      sectionId: 'world',
      sectionName: 'World',
      webPublicationDate: '2024-01-01T00:00:00Z',
      webUrl: 'https://www.theguardian.com/world/test',
      fields: count ? { headline: 'Test', body: `<p>${body}</p>` } : {},
      tags: [],
    };
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json({
        response: String(url).includes('/world/test?')
          ? { content: article }
          : { total: 1, currentPage: 1, pages: 1, results: [article] },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const single = await runToolContract(guardianGetArticle, { article_id: article.id });
    expect(single.isError).not.toBe(true);
    expect(single.structuredContent).toMatchObject({ truncated: false });
    const singleText = single.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(singleText).toContain('**Truncated:** false');
    if (count) {
      expect(single.structuredContent).toHaveProperty('body', body);
      expect(singleText).toContain(`\n${body}\n**Truncated:** false`);
    } else expect(singleText).toContain('Body not available');
    expect(singleText).not.toContain('Article truncated');
    for (const [definition, input] of [
      [guardianSearchArticles, { query: 'test' }],
      [guardianBrowseContent, { mode: 'section_latest', section_id: 'world' }],
      [guardianBrowseContent, { mode: 'tag_latest', tag_id: 'world/ukraine' }],
    ] as const) {
      const result = await runToolContract(
        definition as typeof guardianSearchArticles,
        input as never,
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty('results.0.truncated', count > 2000);
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text.toLowerCase()).toContain(`**truncated:** ${count > 2000}`);
      if (count > 2000) {
        const preview =
          body.split(' ').slice(0, 2000).join(' ') +
          `\n\n[Article truncated at 2,000 words. Use guardian_get_article with article_id "${article.id}" to retrieve the full text.]`;
        expect(result.structuredContent).toHaveProperty('results.0.body', preview);
        expect(text).toContain(preview);
        expect(text).toContain(`article_id "${article.id}"`);
        expect(text).not.toContain('word2000');
      } else if (count) {
        expect(result.structuredContent).toHaveProperty('results.0.body', body);
        expect(text).toContain(`\n${body}\n`);
      } else {
        expect(result.structuredContent).not.toHaveProperty('results.0.body');
      }
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('preserves empty pages past the end when the archive total is positive', async () => {
    initGuardianService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ response: { total: 1, currentPage: 2, pages: 1, results: [] } }),
      ),
    );
    const result = await runToolContract(guardianSearchArticles, { query: 'test', page: 2 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ total: 1, page: 2, pages: 1, results: [] });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('**Page:** 2/1'),
    });
  });
});
