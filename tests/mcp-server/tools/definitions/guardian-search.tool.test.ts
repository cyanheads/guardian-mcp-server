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
// Tests
// ---------------------------------------------------------------------------

describe('guardianSearch', () => {
  describe('handler', () => {
    it('returns search results for a valid query', async () => {
      mockService.search.mockResolvedValueOnce(sampleSearchResult);
      const ctx = createMockContext({ errors: guardianSearch.errors });
      const input = guardianSearch.input.parse({ query: 'climate change' });

      const result = await guardianSearch.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].id).toBe(sampleArticle.id);
      expect(result.results[0].headline).toBe('Test Headline');
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
      expect(result.results[0].standfirst).toBeUndefined();
      expect(result.results[0].body).toBeUndefined();
      expect(result.results[0].word_count).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders article headline, metadata, and body', () => {
      const [block] = guardianSearch.format!(sampleSearchResult);
      expect(block.type).toBe('text');
      expect(block.text).toContain('Test Headline');
      expect(block.text).toContain(sampleArticle.id);
      expect(block.text).toContain('Jane Doe');
      expect(block.text).toContain('This is the article body text.');
    });

    it('shows truncation note when truncated is true', () => {
      const truncatedResult = {
        ...sampleSearchResult,
        results: [{ ...sampleArticle, truncated: true }],
      };
      const [block] = guardianSearch.format!(truncatedResult);
      expect(block.text).toContain('guardian_get_article');
    });

    it('notes absent body for non-article content types', () => {
      const noBodyResult = {
        ...sampleSearchResult,
        results: [{ ...sampleArticle, body: undefined }],
      };
      const [block] = guardianSearch.format!(noBodyResult);
      expect(block.text).toContain('not available');
    });
  });
});
