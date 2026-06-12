/**
 * @fileoverview Tests for guardian_browse tool.
 * @module tests/mcp-server/tools/definitions/guardian-browse.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardianBrowse } from '@/mcp-server/tools/definitions/guardian-browse.tool.js';

vi.mock('@/services/guardian/guardian-service.js', () => ({
  getGuardianService: vi.fn(),
}));

import { getGuardianService } from '@/services/guardian/guardian-service.js';

const mockService = {
  getSectionContent: vi.fn(),
  search: vi.fn(),
  getSections: vi.fn(),
  getTags: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getGuardianService).mockReturnValue(mockService as never);
  mockService.getSectionContent.mockReset();
  mockService.search.mockReset();
  mockService.getSections.mockReset();
  mockService.getTags.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleArticle = {
  id: 'world/2024/jan/15/test',
  type: 'article',
  section_id: 'world',
  section_name: 'World news',
  published_date: '2024-01-15T12:00:00Z',
  headline: 'Test Article',
  web_url: 'https://www.theguardian.com/world/2024/jan/15/test',
  truncated: false,
  contributors: [],
};

const sampleSearchResult = {
  total: 3,
  page: 1,
  pages: 1,
  page_size: 3,
  order_by: 'newest',
  results: [sampleArticle],
};

const sampleSections = [
  { id: 'world', name: 'World news', web_url: 'https://www.theguardian.com/world' },
  { id: 'politics', name: 'Politics', web_url: 'https://www.theguardian.com/politics' },
];

const sampleTags = [
  {
    id: 'environment/climate-change',
    type: 'keyword',
    name: 'Climate change',
    web_url: 'https://www.theguardian.com/environment/climate-change',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('guardianBrowse', () => {
  describe('section_latest mode', () => {
    it('returns recent articles from the section', async () => {
      mockService.getSectionContent.mockResolvedValueOnce(sampleSearchResult);
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'section_latest', section_id: 'world' });

      const result = await guardianBrowse.handler(input, ctx);

      expect(result.mode).toBe('section_latest');
      if (result.mode === 'section_latest') {
        expect(result.total).toBe(3);
        expect(result.results).toHaveLength(1);
      }
    });

    it('throws missing_section_id with data.reason when section_id is absent', async () => {
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'section_latest' });

      await expect(guardianBrowse.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'missing_section_id' },
      });
    });

    it('throws section_not_found with data.reason when total is 0', async () => {
      mockService.getSectionContent.mockResolvedValueOnce({
        ...sampleSearchResult,
        total: 0,
        results: [],
      });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({
        mode: 'section_latest',
        section_id: 'invalid-section',
      });

      await expect(guardianBrowse.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'section_not_found' },
      });
    });
  });

  describe('tag_latest mode', () => {
    it('returns articles tagged with the given tag', async () => {
      mockService.search.mockResolvedValueOnce(sampleSearchResult);
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({
        mode: 'tag_latest',
        tag_id: 'environment/climate-change',
      });

      const result = await guardianBrowse.handler(input, ctx);

      expect(result.mode).toBe('tag_latest');
      if (result.mode === 'tag_latest') {
        expect(result.results).toHaveLength(1);
      }
    });

    it('throws missing_tag_id with data.reason when tag_id is absent', async () => {
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'tag_latest' });

      await expect(guardianBrowse.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'missing_tag_id' },
      });
    });

    it('throws tag_not_found with data.reason when total is 0', async () => {
      mockService.search.mockResolvedValueOnce({ ...sampleSearchResult, total: 0, results: [] });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'tag_latest', tag_id: 'no/such/tag' });

      await expect(guardianBrowse.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'tag_not_found' },
      });
    });
  });

  describe('list_sections mode', () => {
    it('returns all sections', async () => {
      mockService.getSections.mockResolvedValueOnce({ total: 2, sections: sampleSections });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'list_sections' });

      const result = await guardianBrowse.handler(input, ctx);

      expect(result.mode).toBe('list_sections');
      if (result.mode === 'list_sections') {
        expect(result.total).toBe(2);
        expect(result.sections).toHaveLength(2);
        expect(result.sections[0].id).toBe('world');
      }
    });

    it('passes query to getSections when provided', async () => {
      mockService.getSections.mockResolvedValueOnce({ total: 1, sections: [sampleSections[0]] });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'list_sections', query: 'world' });

      await guardianBrowse.handler(input, ctx);

      expect(mockService.getSections).toHaveBeenCalledWith('world', ctx);
    });
  });

  describe('list_tags mode', () => {
    it('returns tags matching a query', async () => {
      mockService.getTags.mockResolvedValueOnce({ total: 1, page: 1, pages: 1, tags: sampleTags });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'list_tags', query: 'climate' });

      const result = await guardianBrowse.handler(input, ctx);

      expect(result.mode).toBe('list_tags');
      if (result.mode === 'list_tags') {
        expect(result.total).toBe(1);
        expect(result.tags[0].id).toBe('environment/climate-change');
      }
    });

    it('passes tag_type to getTags', async () => {
      mockService.getTags.mockResolvedValueOnce({ total: 0, page: 1, pages: 1, tags: [] });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'list_tags', tag_type: 'contributor' });

      await guardianBrowse.handler(input, ctx);

      expect(mockService.getTags).toHaveBeenCalledWith(
        expect.objectContaining({ tag_type: 'contributor' }),
        ctx,
      );
    });
  });

  describe('error contract propagation', () => {
    it('propagates unauthorized with reason="unauthorized" on section_latest', async () => {
      mockService.getSectionContent.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.Unauthorized, 'Invalid API key', {
          statusCode: 401,
          reason: 'unauthorized',
        }),
      );
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'section_latest', section_id: 'world' });

      await expect(guardianBrowse.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'unauthorized' },
      });
    });

    it('propagates unauthorized with reason="unauthorized" on list_sections', async () => {
      mockService.getSections.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.Unauthorized, 'Invalid API key', {
          statusCode: 401,
          reason: 'unauthorized',
        }),
      );
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'list_sections' });

      await expect(guardianBrowse.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        data: { reason: 'unauthorized' },
      });
    });
  });

  describe('format', () => {
    it('renders section_latest results', async () => {
      mockService.getSectionContent.mockResolvedValueOnce(sampleSearchResult);
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'section_latest', section_id: 'world' });
      const result = await guardianBrowse.handler(input, ctx);

      const [block] = guardianBrowse.format!(result);
      expect(block.type).toBe('text');
      expect(block.text).toContain('Test Article');
      expect(block.text).toContain('section_latest');
    });

    it('renders list_sections results', async () => {
      mockService.getSections.mockResolvedValueOnce({ total: 2, sections: sampleSections });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'list_sections' });
      const result = await guardianBrowse.handler(input, ctx);

      const [block] = guardianBrowse.format!(result);
      expect(block.text).toContain('list_sections');
      expect(block.text).toContain('world');
      expect(block.text).toContain('politics');
    });

    it('renders list_tags results', async () => {
      mockService.getTags.mockResolvedValueOnce({ total: 1, page: 1, pages: 1, tags: sampleTags });
      const ctx = createMockContext({ errors: guardianBrowse.errors });
      const input = guardianBrowse.input.parse({ mode: 'list_tags', query: 'climate' });
      const result = await guardianBrowse.handler(input, ctx);

      const [block] = guardianBrowse.format!(result);
      expect(block.text).toContain('Climate change');
      expect(block.text).toContain('environment/climate-change');
    });
  });
});
