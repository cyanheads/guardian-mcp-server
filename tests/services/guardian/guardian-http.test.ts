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
      expect(error).not.toHaveProperty('data.body');
      expect(error).not.toHaveProperty('data.statusCode');
      expect(error).not.toHaveProperty('data.responseBody');
      expect(error).not.toHaveProperty('data.rootCause');
      expect(error).not.toHaveProperty('data.url');
      const messages: Record<number, string> = {
        400: 'Guardian API rejected the request (HTTP 400). Check the filters and use an earlier page. Guardian can reject paging past 38,000 results even within the reported page count.',
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
    const fetch = vi.fn(async () => new Response('{"message":"test-key"}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const service = new GuardianService();
    const pending =
      kind === 'article'
        ? service.getContent('world/test', createMockContext())
        : service.getSectionContent('world', {}, createMockContext());
    await expect(pending).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining(`Guardian ${kind} not found`),
      data: {
        body: '{"message":"[REDACTED]"}',
        reason: kind === 'article' ? 'not_found' : 'section_not_found',
        retryable: false,
      },
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
  const articleRow = {
    id: 'environment/heat-pumps/example',
    type: 'article',
    sectionId: 'environment',
    sectionName: 'Environment',
    webPublicationDate: '2024-01-02T00:00:00Z',
    webUrl: 'https://www.theguardian.com/environment/heat-pumps/example',
    fields: { headline: 'Example', body: '<p>Read the article.</p>' },
  };

  it.each([
    [
      'comments with nested markup',
      '<p>Before<!-- hidden <p>comment</p> --> after</p>',
      'Before after',
    ],
    [
      'raw script text',
      '<p>Before<script>let value = "</script.foo>";</ScRiPt > after</p>',
      'Before after',
    ],
    ['raw style text', '<p>Before<style>/* </style.foo> */</style> after</p>', 'Before after'],
    [
      'quoted attributes',
      '<p>Before<a title="left < right > middle"> after</a></p>',
      'Before after',
    ],
    ['opening block boundaries', 'Before<div>Inside</div><p>After</p>', 'Before\nInside\nAfter'],
    [
      'table captions',
      '<table><caption>League table</caption><tr><th>Pos</th><th>Team</th></tr><tr><td>1</td><td>PSG</td></tr></table>',
      'League table\nPos | Team\n1 | PSG',
    ],
    [
      'optional table cell and row end tags',
      '<table><tr><th>Pos<th>Team<tr><td>1<td>PSG</table>',
      'Pos | Team\n1 | PSG',
    ],
    [
      'nested tables inside a cell',
      '<table><tr><td>Top<table><caption>Nested</caption><tr><td>A<td>B</table>Tail<td>Next</table>',
      'Top Nested A B Tail | Next',
    ],
  ])('retains visible article text through %s', async (_case, body, expected) => {
    initGuardianService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          response: { status: 'ok', content: { ...articleRow, fields: { body } } },
        }),
      ),
    );
    const result = await runToolContract(guardianGetArticle, { article_id: articleRow.id });
    expect(result.structuredContent).toHaveProperty('body', expected);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(expected.replaceAll('|', '\\|').replaceAll('\n', '\\\n')),
    });
  });

  it.each([
    ['long line with a break', (size: number) => `<p>${'<'.repeat(size)}</p><p>tail</p>`],
    [
      'unclosed tags with overlapping names',
      (size: number) => '<script.foo <style.foo '.repeat(Math.ceil(size / 23)),
    ],
    [
      'comments, raw text, and quoted attributes',
      (size: number) =>
        '<!-- <p>x</p> --><script>"</script.foo>"</script><a title="<p>">x</a>'.repeat(
          Math.ceil(size / 67),
        ),
    ],
    [
      'table rows with implicit closing tags',
      (size: number) =>
        '<table><caption>Scores</caption><tr><td>1<td>PSG</table>'.repeat(Math.ceil(size / 56)),
    ],
    [
      'mixed line breaks',
      (size: number) => '<p>open \t &amp;copy; <br> next\n</p>'.repeat(Math.ceil(size / 35)),
    ],
  ] as const)(
    'keeps detail normalization and formatting linear for %s',
    async (_name, makeBody) => {
      initGuardianService();
      let response = '';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(response)),
      );
      async function measure(size: number): Promise<number> {
        response = JSON.stringify({
          response: {
            status: 'ok',
            content: { ...articleRow, fields: { body: makeBody(size) } },
          },
        });
        let best = Number.POSITIVE_INFINITY;
        for (let sample = 0; sample < 5; sample++) {
          const start = process.threadCpuUsage();
          const result = await runToolContract(guardianGetArticle, { article_id: articleRow.id });
          const { user, system } = process.threadCpuUsage(start);
          expect(result.isError).not.toBe(true);
          best = Math.min(best, user + system);
        }
        return best;
      }
      for (let size = 10_000; size <= 320_000; size *= 2) {
        const baseline = await measure(5_000);
        expect((await measure(size)) / baseline).toBeLessThan(256);
      }
    },
  );

  it('preserves table rows, nested inline text, and entity-like prose on every article surface', async () => {
    initGuardianService();
    const article = {
      ...articleRow,
      fields: {
        headline: '[A *headline*]',
        thumbnail: 'https://media.guim.co.uk/thumb.jpg',
        body: '<p>@__itzpsyiconic__ &amp;copy;</p><table>\n  <thead><tr><th> Pos </th><th>Team</th></tr></thead>\n <tbody><tr><td>1</td><td><strong>PSG</strong></td></tr>\n <tr><td>2</td><td>Real <em>Madrid</em></td></tr></tbody></table><p>More coverage.</p>',
      },
    };
    const fetch = vi.fn(async (request: string) => {
      const url = new URL(request);
      expect(url.origin).toBe('https://content.guardianapis.com');
      return Response.json({
        response:
          url.pathname === `/${article.id}`
            ? { status: 'ok', content: article }
            : {
                status: 'ok',
                section: { id: 'environment' },
                total: 1,
                currentPage: 1,
                pages: 1,
                results: [article],
              },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const search = await runToolContract(guardianSearchArticles, { query: 'test' });
    const browse = await runToolContract(guardianBrowseContent, {
      mode: 'section_latest',
      section_id: 'environment',
    });
    const detail = await runToolContract(guardianGetArticle, { article_id: article.id });
    const expected =
      '@__itzpsyiconic__ &copy;\n\nPos | Team\n1 | PSG\n2 | Real Madrid\n\nMore coverage.';
    expect(search.structuredContent).toHaveProperty('results.0.body', expected);
    expect(browse.structuredContent).toHaveProperty('results.0.body', expected);
    expect(detail.structuredContent).toHaveProperty('body', expected);
    expect(detail.structuredContent).toHaveProperty('tags', []);
    expect(detail.structuredContent).not.toHaveProperty('first_published_date');
    expect(detail.structuredContent).not.toHaveProperty('last_modified');
    for (const result of [search, browse, detail]) {
      const block = result.content[0];
      expect(block?.type).toBe('text');
      if (block?.type !== 'text') throw new Error('Expected article text block');
      expect(block.text).toContain('\\[A \\*headline\\*\\]');
      expect(block.text).toContain('@\\_\\_itzpsyiconic\\_\\_ \\&copy;');
      expect(block.text).toContain('Pos \\| Team\\\n1 \\| PSG\\\n2 \\| Real Madrid');
      expect(block.text).toContain(`[${article.webUrl}](<${article.webUrl}>)`);
      expect(block.text).toContain('![Article thumbnail](<https://media.guim.co.uk/thumb.jpg>)');
      expect(block.text).not.toMatch(/First published:|Last modified:/);
    }
  });

  it.each([
    ['environment', 'section'],
    ['au/environment', 'edition'],
    ['environment/heat-pumps', 'tag'],
  ])('keeps valid %s collection markers and pagination', async (id, marker) => {
    initGuardianService();
    const fetch = vi.fn(async (request: string) => {
      const url = new URL(request);
      expect(url.origin).toBe('https://content.guardianapis.com');
      expect(url.pathname).toBe(`/${id}`);
      const page = Number(url.searchParams.get('page'));
      return Response.json({
        response: {
          status: 'ok',
          [marker]: { id },
          total: 1,
          currentPage: page,
          pages: 1,
          results: page === 1 ? [articleRow] : [],
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const first = await runToolContract(guardianBrowseContent, {
      mode: 'section_latest',
      section_id: id,
    });
    expect(first.structuredContent).toMatchObject({
      total: 1,
      page: 1,
      pages: 1,
      results: [{ id: articleRow.id }],
    });
    expect(first.content[0]).toMatchObject({ text: expect.stringContaining(articleRow.id) });
    const second = await runToolContract(guardianBrowseContent, {
      mode: 'section_latest',
      section_id: id,
      page: 2,
    });
    expect(second.structuredContent).toMatchObject({ total: 1, page: 2, pages: 1, results: [] });
    expect(second.content[0]).toMatchObject({ text: expect.stringContaining('page: 2/1') });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['environment/heat-pumps/example', { status: 'ok', content: articleRow }],
    ['search', { status: 'ok', total: 1, currentPage: 1, pages: 1, results: [articleRow] }],
    [
      'tags',
      {
        status: 'ok',
        total: 1,
        currentPage: 1,
        pages: 1,
        results: [{ id: 'environment/heat-pumps', type: 'keyword' }],
      },
    ],
    [
      'environment',
      {
        status: 'ok',
        section: { id: 'environment' },
        total: 1,
        currentPage: 1,
        pages: 1,
        results: [{ id: 'incomplete' }],
      },
    ],
  ])('rejects a %s response without a valid article collection', async (section_id, response) => {
    vi.useFakeTimers();
    initGuardianService();
    const fetch = vi.fn(async () => Response.json({ response }));
    vi.stubGlobal('fetch', fetch);
    const pending = runToolContract(guardianBrowseContent, { mode: 'section_latest', section_id });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'section_not_found', retryable: false },
      },
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('section_not_found') });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps URL query syntax inside the path of a bare ID and rejects a foreign article URL', async () => {
    initGuardianService();
    const fetch = vi.fn(async (request: string) => {
      const url = new URL(request);
      expect(url.origin).toBe('https://content.guardianapis.com');
      expect(url.pathname).toBe('/world/test%3Ftag%3Dinjected%23fragment');
      expect(url.searchParams.has('tag')).toBe(false);
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    for (const article_id of [
      'world/test?tag=injected#fragment',
      'https://example.org/world/test',
    ]) {
      const result = await runToolContract(guardianGetArticle, { article_id });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'not_found', retryable: false } },
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['section_latest', { section_id: 'environment' }, '/environment'],
    ['tag_latest', { tag_id: 'environment/heat-pumps' }, '/search'],
  ] as const)('projects the body only when requested for %s', async (mode, id, path) => {
    initGuardianService();
    const fetch = vi.fn(async (request: string) => {
      const url = new URL(request);
      expect(url.origin).toBe('https://content.guardianapis.com');
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get('page-size')).toBe('50');
      return Response.json({
        response: {
          status: 'ok',
          section: { id: 'environment' },
          total: 1,
          currentPage: 1,
          pages: 1,
          results: [articleRow],
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const args = { mode, ...id, page_size: 50 };
    const byDefault = await runToolContract(guardianBrowseContent, args);
    const full = await runToolContract(guardianBrowseContent, { ...args, include_body: true });
    const metadata = await runToolContract(guardianBrowseContent, { ...args, include_body: false });
    expect(byDefault.structuredContent).toEqual(full.structuredContent);
    expect(byDefault.content).toEqual(full.content);
    expect(full.structuredContent).toHaveProperty('results.0.body', 'Read the article.');
    expect(full.content[0]).toMatchObject({ text: expect.stringContaining('Read the article.') });
    expect(metadata.structuredContent).toMatchObject({
      total: 1,
      page: 1,
      pages: 1,
      results: [{ id: articleRow.id, truncated: false }],
    });
    expect(metadata.structuredContent).not.toHaveProperty('results.0.body');
    expect(metadata.content[0]).toMatchObject({
      text: expect.stringContaining('**truncated:** false'),
    });
    expect(JSON.stringify(metadata)).not.toMatch(
      /Read the article|Body not available|Article truncated/,
    );
    expect(
      fetch.mock.calls.map(([request]) => new URL(request).searchParams.get('show-fields')),
    ).toEqual([
      'body,headline,byline,thumbnail,wordcount,standfirst',
      'body,headline,byline,thumbnail,wordcount,standfirst',
      'headline,byline,thumbnail,wordcount,standfirst',
    ]);
  });

  it('accepts a Guardian URL and requests detail tags and dates', async () => {
    initGuardianService();
    const fetch = vi.fn(async (request: string) => {
      const url = new URL(request);
      expect(url.origin).toBe('https://content.guardianapis.com');
      const id = url.pathname.slice(1);
      return Response.json({
        response: {
          status: 'ok',
          content: {
            id,
            type: 'crossword',
            sectionId: 'crosswords',
            sectionName: 'Crosswords',
            webPublicationDate: '2024-01-02T00:00:00Z',
            webUrl: 'https://www.theguardian.com/crosswords/cryptic/30155',
            fields: { firstPublicationDate: '2024-01-01T00:00:00Z' },
            tags: [{ id: 'crosswords/series/cryptic', type: 'series', webTitle: 'Cryptic' }],
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(guardianGetArticle, {
      article_id: 'https://www.theguardian.com/crosswords/cryptic/30155?tag=override#anchor',
    });
    expect(result.structuredContent).toMatchObject({
      id: 'crosswords/cryptic/30155',
      body: expect.stringContaining('crossword'),
      first_published_date: '2024-01-01T00:00:00Z',
      tags: [{ id: 'crosswords/series/cryptic', type: 'series', name: 'Cryptic' }],
    });
    expect(result.structuredContent).not.toHaveProperty('last_modified');
    const url = new URL(fetch.mock.calls[0]?.[0] ?? '');
    expect(url.searchParams.get('tag')).toBeNull();
    expect(url.searchParams.get('show-tags')).toBe('keyword,series,tone,contributor');
    expect(url.searchParams.get('show-fields')?.split(',')).toEqual(
      expect.arrayContaining(['firstPublicationDate', 'lastModified']),
    );
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(/2024-01-01T00:00:00Z[\s\S]*crosswords\/series\/cryptic/),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses article-specific recovery for an upstream HTTP 400', async () => {
    initGuardianService();
    const fetch = vi.fn(async () => new Response('private upstream payload', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(guardianGetArticle, { article_id: 'world/example' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('article_id'),
          data: {
            status: 400,
            reason: 'request_rejected',
            retryable: false,
            recovery: { hint: expect.stringContaining('article_id') },
          },
        },
      },
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('article_id') });
    expect(JSON.stringify(result)).not.toContain('private upstream payload');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects inverted dates without requesting any endpoint', async () => {
    initGuardianService();
    const fetch = vi.fn(async () =>
      Response.json({ response: { total: 0, currentPage: 1, pages: 0, results: [] } }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(guardianSearchArticles, {
      query: '',
      from_date: '2024-06-01',
      to_date: '2024-01-01',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        message: expect.stringMatching(/from_date.*2024-06-01.*to_date.*2024-01-01/),
        data: { reason: 'invalid_date' },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'relevance', null, 'newest', true],
    [' \t ', 'oldest', null, 'oldest', false],
    ['', 'newest', null, 'newest', false],
    [' climate ', 'relevance', ' climate ', 'relevance', false],
  ] as const)(
    'applies the sort for %j with %s',
    async (query, order_by, sentQuery, order, notice) => {
      initGuardianService();
      const fetch = vi.fn(async (request: string) => {
        const url = new URL(request);
        expect(url.origin).toBe('https://content.guardianapis.com');
        expect(url.searchParams.get('q')).toBe(sentQuery);
        expect(url.searchParams.get('order-by')).toBe(order);
        expect(url.searchParams.get('from-date')).toBe('2024-01-02');
        expect(url.searchParams.get('to-date')).toBe('2024-01-02');
        expect(url.searchParams.get('tag')).toBe(
          '(profile/georgemonbiot|profile/fionaharvey),-profile/damiancarrington',
        );
        return Response.json({
          response: { total: 1, currentPage: 1, pages: 1, results: [articleRow] },
        });
      });
      vi.stubGlobal('fetch', fetch);
      const result = await runToolContract(guardianSearchArticles, {
        query,
        order_by,
        from_date: '2024-01-02',
        to_date: '2024-01-02',
        contributor: '(profile/georgemonbiot|profile/fionaharvey),-profile/damiancarrington',
      });
      expect(result.structuredContent).toHaveProperty('order_by', order);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(`**Sort:** ${order}`),
      });
      const explanation =
        'Sorted by newest because the query is blank and relevance requires search terms.';
      if (notice) {
        expect(result.structuredContent).toHaveProperty('notice', explanation);
        expect(result.content.at(-1)).toMatchObject({ text: expect.stringContaining(explanation) });
      } else {
        expect(result.structuredContent).not.toHaveProperty('notice');
        expect(JSON.stringify(result.content)).not.toContain(explanation);
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('reports the active filters for a blank-query miss', async () => {
    initGuardianService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          response: { total: 0, currentPage: 1, pages: 0, results: [] },
        }),
      ),
    );
    const result = await runToolContract(guardianSearchArticles, {
      query: ' ',
      section: 'unknown',
      from_date: '',
      to_date: '2024-01-02',
    });
    const message = 'No articles matched section "unknown", to_date "2024-01-02".';
    expect(result.structuredContent).toMatchObject({
      error: { message, data: { reason: 'no_results' } },
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('section "unknown"'),
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('omits blank queries and body fields while applying newest and normalizing a contributor', async () => {
    initGuardianService();
    const fetch = vi.fn(async (_url: string) =>
      Response.json({
        response: {
          total: 1,
          currentPage: 1,
          pages: 1,
          results: [
            {
              id: 'world/example',
              type: 'article',
              sectionId: 'world',
              sectionName: 'World',
              webPublicationDate: '2024-01-01T00:00:00Z',
              webUrl: 'https://www.theguardian.com/world/example',
              fields: { headline: 'Example', body: 'upstream body' },
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(guardianSearchArticles, {
      query: ' \t ',
      contributor: 'georgemonbiot',
      include_body: false,
    } as never);
    const url = new URL(fetch.mock.calls[0]?.[0] ?? '');
    expect(url.origin).toBe('https://content.guardianapis.com');
    expect(url.searchParams.get('q')).toBeNull();
    expect(url.searchParams.get('tag')).toBe('profile/georgemonbiot');
    expect(url.searchParams.get('order-by')).toBe('newest');
    expect(url.searchParams.get('show-fields')?.split(',')).not.toContain('body');
    expect(result.structuredContent).toMatchObject({
      order_by: 'newest',
      results: [{ id: 'world/example', truncated: false }],
    });
    expect(result.structuredContent).not.toHaveProperty('results.0.body');
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('newest') });
    expect(JSON.stringify(result)).not.toContain('upstream body');
  });

  it('forwards section_id to the tag taxonomy endpoint', async () => {
    initGuardianService();
    const fetch = vi.fn(async (request: string) => {
      const url = new URL(request);
      expect(url.origin).toBe('https://content.guardianapis.com');
      expect(url.pathname).toBe('/tags');
      const id =
        url.searchParams.get('section') === 'environment' ? 'environment/climate' : 'world/climate';
      return Response.json({
        response: {
          total: 1,
          currentPage: 1,
          pages: 1,
          results: [
            {
              id,
              type: 'keyword',
              webTitle: 'Climate',
              webUrl: `https://www.theguardian.com/${id}`,
            },
          ],
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(guardianBrowseContent, {
      mode: 'list_tags',
      query: 'climate',
      section_id: 'environment',
    });
    expect(result.structuredContent).toMatchObject({ tags: [{ id: 'environment/climate' }] });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('environment/climate'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a nonretryable reason for a wrong-endpoint article response', async () => {
    vi.useFakeTimers();
    initGuardianService();
    const fetch = vi.fn(async () =>
      Response.json({ response: { status: 'ok', section: { id: 'world' }, results: [] } }),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = runToolContract(guardianGetArticle, { article_id: 'world' });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'not_found', retryable: false } } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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
          response: {
            status: 'ok',
            section: { id: 'world' },
            total: 3,
            currentPage: 1,
            pages: 1,
            results: articles,
          },
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
    const words = Array.from({ length: count }, (_, index) => `word${index}`);
    const body =
      count > 2 ? `${words.slice(0, 2).join(' ')}\n${words.slice(2).join(' ')}` : words.join(' ');
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
    const fetch = vi.fn(async (url: string) =>
      Response.json({
        response:
          new URL(url).pathname === '/world/test'
            ? { status: 'ok', content: article }
            : {
                status: 'ok',
                section: { id: 'world' },
                total: 1,
                currentPage: 1,
                pages: 1,
                results: [article],
              },
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
      expect(singleText).toContain(`\n${body.replaceAll('\n', '\\\n')}\n\n**Truncated:** false`);
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
          body.slice(0, body.lastIndexOf(' ')) +
          `\n\n[Article truncated at 2,000 words. Use guardian_get_article with article_id "${article.id}" to retrieve the full text.]`;
        expect(result.structuredContent).toHaveProperty('results.0.body', preview);
        expect(text.match(/Article truncated/g)).toHaveLength(1);
        expect(text.match(/article_id "/g)).toHaveLength(1);
        expect(text).not.toContain('word2000');
      } else if (count) {
        expect(result.structuredContent).toHaveProperty('results.0.body', body);
        expect(text).toContain(`\n${body.replaceAll('\n', '\\\n')}\n`);
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
