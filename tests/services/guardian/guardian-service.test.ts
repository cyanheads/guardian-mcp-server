/**
 * @fileoverview Unit tests for GuardianService — HTML stripping, body truncation,
 * response normalization, and error annotation (mocked HTTP).
 * @module tests/services/guardian/guardian-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardianService } from '@/services/guardian/guardian-service.js';

// ---------------------------------------------------------------------------
// Mock server config so we don't need a real GUARDIAN_API_KEY in tests
// ---------------------------------------------------------------------------
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({ apiKey: 'test-key' })),
}));

// ---------------------------------------------------------------------------
// Mock fetchWithTimeout so tests don't hit the network
// ---------------------------------------------------------------------------
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...original,
    fetchWithTimeout: vi.fn(),
    // withRetry: just calls the fn directly in tests
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GuardianService', () => {
  let svc: GuardianService;

  beforeEach(() => {
    svc = new GuardianService();
    vi.mocked(fetchWithTimeout).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('search', () => {
    it('normalizes a standard search result', async () => {
      const raw = {
        response: {
          status: 'ok',
          total: 1,
          startIndex: 1,
          pageSize: 1,
          currentPage: 1,
          pages: 1,
          orderBy: 'relevance',
          results: [
            {
              id: 'world/2024/jan/15/test',
              type: 'article',
              sectionId: 'world',
              sectionName: 'World news',
              webPublicationDate: '2024-01-15T12:00:00Z',
              webUrl: 'https://www.theguardian.com/world/2024/jan/15/test',
              apiUrl: 'https://content.guardianapis.com/world/2024/jan/15/test',
              pillarId: 'pillar/news',
              pillarName: 'News',
              fields: {
                headline: '<p>Test Headline</p>',
                standfirst: '<ul><li>Summary point</li></ul>',
                byline: 'Jane Doe',
                body: '<p>Body paragraph one.</p><p>Body paragraph two.</p>',
                wordcount: '300',
                thumbnail: 'https://media.guim.co.uk/thumb.jpg',
              },
              tags: [
                {
                  id: 'profile/jane-doe',
                  type: 'contributor',
                  webTitle: 'Jane Doe',
                  webUrl: 'https://www.theguardian.com/profile/jane-doe',
                },
              ],
            },
          ],
        },
      };

      vi.mocked(fetchWithTimeout).mockResolvedValueOnce(makeResponse(JSON.stringify(raw)));
      const ctx = createMockContext();
      const result = await svc.search({ query: 'test' }, ctx);

      expect(result.total).toBe(1);
      expect(result.results[0].headline).toBe('Test Headline');
      expect(result.results[0].standfirst).toContain('Summary point');
      // HTML tags stripped from standfirst
      expect(result.results[0].standfirst).not.toContain('<ul>');
      // body stripped and normalized
      expect(result.results[0].body).toContain('Body paragraph one.');
      expect(result.results[0].body).not.toContain('<p>');
      expect(result.results[0].word_count).toBe(300);
      expect(result.results[0].contributors).toHaveLength(1);
      expect(result.results[0].contributors[0].name).toBe('Jane Doe');
      expect(result.results[0].pillar_id).toBe('pillar/news');
    });

    it('handles sparse results with no fields sub-object', async () => {
      const raw = {
        response: {
          status: 'ok',
          total: 1,
          startIndex: 1,
          pageSize: 1,
          currentPage: 1,
          pages: 1,
          orderBy: 'newest',
          results: [
            {
              id: 'world/2024/jan/15/sparse',
              type: 'liveblog',
              sectionId: 'world',
              sectionName: 'World news',
              webPublicationDate: '2024-01-15T12:00:00Z',
              webUrl: 'https://www.theguardian.com/world/2024/jan/15/sparse',
              apiUrl: 'https://content.guardianapis.com/world/2024/jan/15/sparse',
              // no fields, no tags
            },
          ],
        },
      };

      vi.mocked(fetchWithTimeout).mockResolvedValueOnce(makeResponse(JSON.stringify(raw)));
      const ctx = createMockContext();
      const result = await svc.search({ query: 'sparse' }, ctx);

      const article = result.results[0];
      expect(article.headline).toBe('');
      expect(article.body).toBeUndefined();
      expect(article.truncated).toBe(false);
      expect(article.contributors).toEqual([]);
    });

    it('truncates long bodies at 2000 words and appends a note', async () => {
      // 2100-word body
      const longBody =
        '<p>' + Array.from({ length: 2100 }, (_, i) => `word${i}`).join(' ') + '</p>';
      const raw = {
        response: {
          status: 'ok',
          total: 1,
          startIndex: 1,
          pageSize: 1,
          currentPage: 1,
          pages: 1,
          orderBy: 'newest',
          results: [
            {
              id: 'world/2024/jan/15/long',
              type: 'article',
              sectionId: 'world',
              sectionName: 'World news',
              webPublicationDate: '2024-01-15T12:00:00Z',
              webUrl: 'https://www.theguardian.com/world/2024/jan/15/long',
              apiUrl: 'https://content.guardianapis.com/world/2024/jan/15/long',
              fields: { body: longBody, wordcount: '2100' },
              tags: [],
            },
          ],
        },
      };

      vi.mocked(fetchWithTimeout).mockResolvedValueOnce(makeResponse(JSON.stringify(raw)));
      const ctx = createMockContext();
      const result = await svc.search({ query: 'long' }, ctx);

      const article = result.results[0];
      expect(article.truncated).toBe(true);
      expect(article.body).toContain('[Article truncated at 2,000 words');
      expect(article.body).toContain('guardian_get_article');
      // Body should not exceed 2000 words before the note
      const wordsBeforeNote = article.body!.split('[Article truncated')[0].trim().split(/\s+/);
      expect(wordsBeforeNote.length).toBeLessThanOrEqual(2000);
    });

    it('throws on HTML error-page responses', async () => {
      vi.mocked(fetchWithTimeout).mockResolvedValueOnce(
        new Response('<!DOCTYPE html><html><body>Error page</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
      const ctx = createMockContext();

      await expect(svc.search({ query: 'test' }, ctx)).rejects.toThrow();
    });
  });

  describe('getSections', () => {
    it('normalizes sections using webTitle as name', async () => {
      const raw = {
        response: {
          status: 'ok',
          total: 2,
          results: [
            {
              id: 'world',
              webTitle: 'World news',
              webUrl: 'https://www.theguardian.com/world',
              apiUrl: '',
            },
            {
              id: 'politics',
              webTitle: 'Politics',
              webUrl: 'https://www.theguardian.com/politics',
              apiUrl: '',
            },
          ],
        },
      };

      vi.mocked(fetchWithTimeout).mockResolvedValueOnce(makeResponse(JSON.stringify(raw)));
      const ctx = createMockContext();
      const result = await svc.getSections(undefined, ctx);

      expect(result.total).toBe(2);
      expect(result.sections[0].id).toBe('world');
      expect(result.sections[0].name).toBe('World news');
    });
  });

  describe('getTags', () => {
    it('normalizes tags using webTitle as name', async () => {
      const raw = {
        response: {
          status: 'ok',
          total: 1,
          startIndex: 1,
          pageSize: 10,
          currentPage: 1,
          pages: 1,
          results: [
            {
              id: 'environment/climate-change',
              type: 'keyword',
              webTitle: 'Climate change',
              webUrl: 'https://www.theguardian.com/environment/climate-change',
            },
          ],
        },
      };

      vi.mocked(fetchWithTimeout).mockResolvedValueOnce(makeResponse(JSON.stringify(raw)));
      const ctx = createMockContext();
      const result = await svc.getTags({ query: 'climate' }, ctx);

      expect(result.total).toBe(1);
      expect(result.tags[0].id).toBe('environment/climate-change');
      expect(result.tags[0].name).toBe('Climate change');
      expect(result.tags[0].type).toBe('keyword');
    });
  });

  describe('error annotation', () => {
    it('annotates 401 responses with reason="unauthorized" on search', async () => {
      vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.Unauthorized, 'Fetch failed. Status: 401', {
          statusCode: 401,
          statusText: 'Unauthorized',
        }),
      );
      const ctx = createMockContext();

      await expect(svc.search({ query: 'test' }, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'unauthorized' },
      });
    });

    it('annotates 401 responses with reason="unauthorized" on getContent', async () => {
      vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.Unauthorized, 'Fetch failed. Status: 401', {
          statusCode: 401,
          statusText: 'Unauthorized',
        }),
      );
      const ctx = createMockContext();

      await expect(svc.getContent('some/article/id', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'unauthorized' },
      });
    });

    it('annotates 404 responses with reason="not_found" on getContent', async () => {
      vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404', {
          statusCode: 404,
          statusText: 'Not Found',
        }),
      );
      const ctx = createMockContext();

      await expect(svc.getContent('invalid/article/id', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
    });

    it('annotates non-401/404 errors with reason="api_error" on search', async () => {
      vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
          statusCode: 503,
          statusText: 'Service Unavailable',
        }),
      );
      const ctx = createMockContext();

      await expect(svc.search({ query: 'test' }, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'api_error' },
      });
    });

    it('passes through errors that already carry a reason', async () => {
      vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Already annotated', {
          statusCode: 503,
          reason: 'already_set',
        }),
      );
      const ctx = createMockContext();

      await expect(svc.search({ query: 'test' }, ctx)).rejects.toMatchObject({
        data: { reason: 'already_set' },
      });
    });
  });
});
