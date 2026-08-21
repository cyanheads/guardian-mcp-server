/**
 * @fileoverview Tests for guardian_search tool.
 * @module tests/mcp-server/tools/definitions/guardian-search.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardianSearch } from '@/mcp-server/tools/definitions/guardian-search.tool.js';

// ---------------------------------------------------------------------------
// Mock the guardian service
// ---------------------------------------------------------------------------
vi.mock('@/services/guardian/guardian-service.js', () => ({
  getGuardianService: vi.fn(),
}));

import { getGuardianService } from '@/services/guardian/guardian-service.js';

const mockService = {
  search: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getGuardianService).mockReturnValue(mockService as never);
  mockService.search.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleArticle = {
  id: 'world/2024/jan/15/test-article',
  type: 'article',
  section_id: 'world',
  section_name: 'World news',
  published_date: '2024-01-15T12:00:00Z',
  headline: 'Test Headline',
  standfirst: 'A test standfirst.',
  byline: 'Jane Doe',
  web_url: 'https://www.theguardian.com/world/2024/jan/15/test-article',
  thumbnail: 'https://media.guim.co.uk/test.jpg',
  word_count: 500,
  body: 'This is the article body text.',
  truncated: false,
  contributors: [{ id: 'profile/jane-doe', name: 'Jane Doe' }],
};

const sampleSearchResult = {
  total: 1,
  page: 1,
  pages: 1,
  page_size: 1,
  order_by: 'relevance',
  results: [sampleArticle],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert an element exists and return it narrowed — fixture reads under noUncheckedIndexedAccess. */
function first<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('Expected at least one item');
  return item;
}

/** Return the text of the first content block, asserting it is a text block. */
function textOf(blocks: ReturnType<NonNullable<typeof guardianSearch.format>>): string {
  const block = first(blocks);
  if (block.type !== 'text') throw new Error('Expected a text content block');
  return block.text;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('guardianSearch', () => {
  describe('handler', () => {
    it('returns search results for a valid query', async () => {
      mockService.search.mockResolvedValueOnce(sampleSearchResult);
      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({ query: 'climate change' });

      const result = await guardianSearch.handler(input, ctx);

      const article = first(result.results);
      expect(article.id).toBe(sampleArticle.id);
      expect(article.headline).toBe('Test Headline');
    });

    it('throws no_results with data.reason="no_results" when total is 0', async () => {
      mockService.search.mockResolvedValueOnce({
        ...sampleSearchResult,
        total: 0,
        results: [],
      });
      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({ query: 'xyzzy impossible query' });

      await expect(guardianSearch.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_results' },
      });
    });

    it('throws invalid_date with data.reason="invalid_date" for malformed from_date', async () => {
      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({
        query: 'test',
        from_date: '15-01-2024', // wrong format
      });

      await expect(guardianSearch.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_date' },
      });
    });

    it('throws invalid_date with data.reason="invalid_date" for malformed to_date', async () => {
      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({
        query: 'test',
        to_date: 'January 15 2024', // wrong format
      });

      await expect(guardianSearch.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_date' },
      });
    });

    it('propagates unauthorized error with reason="unauthorized" from service', async () => {
      mockService.search.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.Unauthorized, 'Invalid API key', {
          statusCode: 401,
          reason: 'unauthorized',
        }),
      );
      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({ query: 'test' });

      await expect(guardianSearch.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'unauthorized' },
      });
    });

    it('passes section and tag filters to the service', async () => {
      mockService.search.mockResolvedValueOnce(sampleSearchResult);
      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({
        query: 'test',
        section: 'politics',
        tag: 'climate-crisis',
        order_by: 'newest',
        page: 2,
        page_size: 5,
      });

      await guardianSearch.handler(input, ctx);

      expect(mockService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          section: 'politics',
          tag: 'climate-crisis',
          order_by: 'newest',
          page: 2,
          page_size: 5,
        }),
        ctx,
      );
    });

    it('handles sparse articles with no optional fields', async () => {
      const sparseArticle = {
        id: 'world/2024/jan/15/sparse',
        type: 'article',
        section_id: 'world',
        section_name: 'World news',
        published_date: '2024-01-15T12:00:00Z',
        headline: 'Sparse Article',
        web_url: 'https://www.theguardian.com/world/2024/jan/15/sparse',
        truncated: false,
        contributors: [],
        // standfirst, byline, thumbnail, word_count, body all absent
      };
      mockService.search.mockResolvedValueOnce({
        ...sampleSearchResult,
        results: [sparseArticle],
      });

      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({ query: 'sparse test' });

      const result = await guardianSearch.handler(input, ctx);
      const sparse = first(result.results);
      expect(sparse.standfirst).toBeUndefined();
      expect(sparse.body).toBeUndefined();
      expect(sparse.word_count).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders article headline, metadata, and body', () => {
      const text = textOf(guardianSearch.format!(sampleSearchResult));
      expect(text).toContain('Test Headline');
      expect(text).toContain(sampleArticle.id);
      expect(text).toContain('Jane Doe');
      expect(text).toContain('This is the article body text.');
    });

    it('shows truncation note when truncated is true', () => {
      const truncatedResult = {
        ...sampleSearchResult,
        results: [{ ...sampleArticle, truncated: true }],
      };
      const text = textOf(guardianSearch.format!(truncatedResult));
      expect(text).toContain('guardian_get_article');
    });

    it('notes absent body for non-article content types', () => {
      const noBodyResult = {
        ...sampleSearchResult,
        results: [{ ...sampleArticle, body: undefined }],
      };
      const text = textOf(guardianSearch.format!(noBodyResult));
      expect(text).toContain('not available');
    });
  });
});
