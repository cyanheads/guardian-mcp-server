/**
 * @fileoverview Tests for guardian_get_article tool.
 * @module tests/mcp-server/tools/definitions/guardian-get-article.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardianGetArticle } from '@/mcp-server/tools/definitions/guardian-get-article.tool.js';

vi.mock('@/services/guardian/guardian-service.js', () => ({
  getGuardianService: vi.fn(),
}));

import { getGuardianService } from '@/services/guardian/guardian-service.js';

const mockService = {
  getContent: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getGuardianService).mockReturnValue(mockService as never);
  mockService.getContent.mockReset();
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
  headline: 'Full Article Headline',
  standfirst: 'The standfirst text.',
  byline: 'John Smith',
  web_url: 'https://www.theguardian.com/world/2024/jan/15/test-article',
  thumbnail: 'https://media.guim.co.uk/thumb.jpg',
  word_count: 1500,
  body: 'The full article body text goes here and continues with interesting content.',
  truncated: false,
  contributors: [{ id: 'profile/john-smith', name: 'John Smith' }],
  pillar_id: 'pillar/news',
  pillar_name: 'News',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('guardianGetArticle', () => {
  describe('handler', () => {
    it('returns a fully populated article', async () => {
      mockService.getContent.mockResolvedValueOnce(sampleArticle);
      const ctx = createMockContext({ errors: guardianGetArticle.errors });
      const input = guardianGetArticle.input.parse({
        article_id: 'world/2024/jan/15/test-article',
      });

      const result = await guardianGetArticle.handler(input, ctx);

      expect(result.id).toBe(sampleArticle.id);
      expect(result.headline).toBe('Full Article Headline');
      expect(result.body).toBe(sampleArticle.body);
      expect(result.truncated).toBe(false);
      expect(result.pillar_id).toBe('pillar/news');
      expect(result.contributors).toHaveLength(1);
    });

    it('passes article_id to the service', async () => {
      mockService.getContent.mockResolvedValueOnce(sampleArticle);
      const ctx = createMockContext({ errors: guardianGetArticle.errors });
      const input = guardianGetArticle.input.parse({
        article_id: 'world/2024/jan/15/test-article',
      });

      await guardianGetArticle.handler(input, ctx);

      expect(mockService.getContent).toHaveBeenCalledWith('world/2024/jan/15/test-article', ctx);
    });

    it('supplies a placeholder body when the upstream omits it (non-article types)', async () => {
      const noBodyArticle = { ...sampleArticle, body: undefined, type: 'gallery' };
      mockService.getContent.mockResolvedValueOnce(noBodyArticle);
      const ctx = createMockContext({ errors: guardianGetArticle.errors });
      const input = guardianGetArticle.input.parse({ article_id: noBodyArticle.id });

      const result = await guardianGetArticle.handler(input, ctx);

      expect(result.body).toContain('Body not available');
    });

    it('propagates not_found with reason="not_found" when article ID does not exist', async () => {
      mockService.getContent.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.NotFound, 'Article not found', {
          statusCode: 404,
          reason: 'not_found',
        }),
      );
      const ctx = createMockContext({ errors: guardianGetArticle.errors });
      const input = guardianGetArticle.input.parse({ article_id: 'invalid/id' });

      await expect(guardianGetArticle.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found' },
      });
    });

    it('propagates unauthorized with reason="unauthorized" for invalid API key', async () => {
      mockService.getContent.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.Unauthorized, 'Invalid API key', {
          statusCode: 401,
          reason: 'unauthorized',
        }),
      );
      const ctx = createMockContext({ errors: guardianGetArticle.errors });
      const input = guardianGetArticle.input.parse({
        article_id: 'world/2024/jan/15/test-article',
      });

      await expect(guardianGetArticle.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'unauthorized' },
      });
    });

    it('handles sparse article with no optional fields', async () => {
      const sparse = {
        id: 'uk/2024/jan/01/brief',
        type: 'article',
        section_id: 'uk',
        section_name: 'UK news',
        published_date: '2024-01-01T08:00:00Z',
        headline: 'Brief News Item',
        web_url: 'https://www.theguardian.com/uk/2024/jan/01/brief',
        body: 'Short body.',
        truncated: false,
        contributors: [],
        // no standfirst, byline, thumbnail, word_count, pillar
      };
      mockService.getContent.mockResolvedValueOnce(sparse);
      const ctx = createMockContext({ errors: guardianGetArticle.errors });
      const input = guardianGetArticle.input.parse({ article_id: sparse.id });

      const result = await guardianGetArticle.handler(input, ctx);

      expect(result.standfirst).toBeUndefined();
      expect(result.byline).toBeUndefined();
      expect(result.thumbnail).toBeUndefined();
      expect(result.word_count).toBeUndefined();
      expect(result.pillar_id).toBeUndefined();
    });
  });

  describe('format', () => {
    it('renders headline, metadata, and body', () => {
      const [block] = guardianGetArticle.format!(
        sampleArticle as ReturnType<typeof guardianGetArticle.handler> extends Promise<infer T>
          ? T
          : never,
      );
      expect(block.type).toBe('text');
      expect(block.text).toContain('Full Article Headline');
      expect(block.text).toContain('John Smith');
      expect(block.text).toContain(sampleArticle.body);
    });

    it('notes truncation when truncated is true', () => {
      const truncated = { ...sampleArticle, truncated: true };
      const [block] = guardianGetArticle.format!(truncated as never);
      expect(block.text).toContain('truncated');
    });
  });
});
