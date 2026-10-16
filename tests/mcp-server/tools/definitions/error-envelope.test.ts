/**
 * @fileoverview Error-envelope tests for all three Guardian tools — drives each definition
 * through `runToolContract` with the real GuardianService over a mocked HTTP layer and
 * checks both client surfaces (`structuredContent.error` and `content[]` text) for
 * argument rejections, handler-thrown contract reasons, and service-thrown reasons.
 * @module tests/mcp-server/tools/definitions/error-envelope.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardianBrowseContent } from '@/mcp-server/tools/definitions/guardian-browse-content.tool.js';
import { guardianGetArticle } from '@/mcp-server/tools/definitions/guardian-get-article.tool.js';
import { guardianSearchArticles } from '@/mcp-server/tools/definitions/guardian-search-articles.tool.js';
import { initGuardianService } from '@/services/guardian/guardian-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({ apiKey: 'test-key' })),
}));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...original,
    fetchWithTimeout: vi.fn(),
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

beforeAll(() => {
  initGuardianService();
});

beforeEach(() => {
  vi.mocked(fetchWithTimeout).mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

interface ErrorEnvelope {
  code: number;
  data?: { reason?: string; retryable?: boolean; recovery?: { hint?: string } };
  message: string;
}

/** The rejection `fetchWithTimeout` raises for a non-OK upstream status. */
function httpFailure(status: number, code: JsonRpcErrorCode): McpError {
  return new McpError(
    code,
    `Fetch failed for https://content.guardianapis.com/search?…. Status: ${status}`,
    { status, statusCode: status },
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorOf(result: CallToolResult): ErrorEnvelope {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error?: ErrorEnvelope } | undefined)?.error;
  if (error === undefined) throw new Error('Expected structuredContent.error');
  return error;
}

function textOf(result: CallToolResult): string {
  const [block] = result.content;
  if (block === undefined || block.type !== 'text') throw new Error('Expected a text block');
  return block.text;
}

/** The declared recovery hint for a reason on a tool's `errors[]` contract. */
function declaredRecovery(
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
): string {
  const entry = errors?.find((e) => e.reason === reason);
  if (entry === undefined) throw new Error(`No contract entry for ${reason}`);
  return entry.recovery;
}

/** Assert a contract failure lands identically on both client surfaces. */
function expectContractFailure(
  result: CallToolResult,
  expected: { code: JsonRpcErrorCode; reason: string; recovery: string },
): void {
  const error = errorOf(result);
  expect(error.code).toBe(expected.code);
  expect(error.data?.reason).toBe(expected.reason);
  expect(error.data?.recovery?.hint).toBe(expected.recovery);

  const text = textOf(result);
  expect(text).toMatch(/^Error: /);
  expect(text).toContain(`Recovery: ${expected.recovery}`);
  expect(text).toContain(`(reason ${expected.reason}`);
}

const emptySearch = {
  response: {
    status: 'ok',
    total: 0,
    startIndex: 0,
    pageSize: 10,
    currentPage: 1,
    pages: 0,
    orderBy: 'relevance',
    results: [],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('argument rejection', () => {
  it('rejects an out-of-range page_size on guardian_search_articles as invalid_arguments', async () => {
    const result = await runToolContract(guardianSearchArticles, {
      query: 'climate',
      page_size: 0,
    });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.data?.recovery?.hint).toEqual(expect.any(String));
    expect(error.message).toContain('page_size');

    const text = textOf(result);
    expect(text).toContain('guardian_search_articles');
    expect(text).toContain('page_size');
    expect(text).toContain('(reason invalid_arguments');
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode on guardian_browse_content as invalid_arguments', async () => {
    const result = await runToolContract(guardianBrowseContent, {
      mode: 'latest' as never,
    });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(textOf(result)).toContain('mode');
  });

  it('rejects a missing article_id on guardian_get_article with a recovery line', async () => {
    const result = await runToolContract(guardianGetArticle, {} as never);

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');

    const text = textOf(result);
    expect(text).toContain('article_id');
    expect(text).toContain('\n\nRecovery: ');
  });
});

describe('handler-thrown contract reasons', () => {
  it('guardian_search_articles invalid_date forwards its declared recovery', async () => {
    const result = await runToolContract(guardianSearchArticles, {
      query: 'climate',
      from_date: '15-01-2024',
    });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.ValidationError,
      reason: 'invalid_date',
      recovery: declaredRecovery(guardianSearchArticles.errors, 'invalid_date'),
    });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('guardian_search_articles no_results forwards its declared recovery', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(jsonResponse(emptySearch));

    const result = await runToolContract(guardianSearchArticles, { query: 'xyzzy' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.NotFound,
      reason: 'no_results',
      recovery: declaredRecovery(guardianSearchArticles.errors, 'no_results'),
    });
  });

  it('guardian_browse_content missing_tag_id forwards its declared recovery', async () => {
    const result = await runToolContract(guardianBrowseContent, { mode: 'tag_latest' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.ValidationError,
      reason: 'missing_tag_id',
      recovery: declaredRecovery(guardianBrowseContent.errors, 'missing_tag_id'),
    });
  });

  it('guardian_browse_content tag_not_found forwards its declared recovery', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(jsonResponse(emptySearch));

    const result = await runToolContract(guardianBrowseContent, {
      mode: 'tag_latest',
      tag_id: 'no/such/tag',
    });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.NotFound,
      reason: 'tag_not_found',
      recovery: declaredRecovery(guardianBrowseContent.errors, 'tag_not_found'),
    });
  });
});

describe('service-thrown contract reasons (thrownBy: service)', () => {
  it.each([
    [
      guardianSearchArticles,
      { query: 'test' },
      400,
      JsonRpcErrorCode.InvalidParams,
      'request_rejected',
      false,
    ],
    [
      guardianGetArticle,
      { article_id: 'world/test' },
      501,
      JsonRpcErrorCode.ServiceUnavailable,
      'api_unsupported',
      false,
    ],
    [
      guardianBrowseContent,
      { mode: 'list_sections' },
      429,
      JsonRpcErrorCode.RateLimited,
      'rate_limited',
      true,
    ],
  ] as const)(
    'wires %s HTTP status %s to both client surfaces',
    async (tool, input, status, code, reason, retryable) => {
      vi.mocked(fetchWithTimeout).mockRejectedValueOnce(httpFailure(status, code));
      const result = await runToolContract(tool as typeof guardianSearchArticles, input as never);
      expectContractFailure(result, {
        code,
        reason,
        recovery: declaredRecovery(tool.errors, reason),
      });
      expect(errorOf(result).data?.retryable).toBe(retryable);
      expect(textOf(result)).toContain(retryable ? '· retryable' : '· not retryable');
    },
  );

  it.each(['from_date', 'to_date'])(
    'rejects invalid calendar %s on both surfaces without HTTP',
    async (field) => {
      const result = await runToolContract(guardianSearchArticles, {
        query: 'test',
        [field]: '1900-02-29',
      });
      expectContractFailure(result, {
        code: JsonRpcErrorCode.ValidationError,
        reason: 'invalid_date',
        recovery: declaredRecovery(guardianSearchArticles.errors, 'invalid_date'),
      });
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    },
  );
  it('guardian_search_articles unauthorized carries the tool-declared recovery from the service', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
      httpFailure(401, JsonRpcErrorCode.Unauthorized),
    );

    const result = await runToolContract(guardianSearchArticles, { query: 'climate' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.Unauthorized,
      reason: 'unauthorized',
      recovery: declaredRecovery(guardianSearchArticles.errors, 'unauthorized'),
    });
  });

  it('guardian_search_articles api_error carries the tool-declared recovery from the service', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
      httpFailure(503, JsonRpcErrorCode.ServiceUnavailable),
    );

    const result = await runToolContract(guardianSearchArticles, { query: 'climate' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: 'api_error',
      recovery: declaredRecovery(guardianSearchArticles.errors, 'api_error'),
    });
  });

  it('guardian_get_article not_found carries the tool-declared recovery from the service', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(httpFailure(404, JsonRpcErrorCode.NotFound));

    const result = await runToolContract(guardianGetArticle, { article_id: 'no/such/article' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.NotFound,
      reason: 'not_found',
      recovery: declaredRecovery(guardianGetArticle.errors, 'not_found'),
    });
  });

  it('guardian_get_article unauthorized carries the tool-declared recovery from the service', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
      httpFailure(401, JsonRpcErrorCode.Unauthorized),
    );

    const result = await runToolContract(guardianGetArticle, { article_id: 'world/2024/x' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.Unauthorized,
      reason: 'unauthorized',
      recovery: declaredRecovery(guardianGetArticle.errors, 'unauthorized'),
    });
  });

  it('guardian_get_article api_error carries the tool-declared recovery from the service', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
      httpFailure(503, JsonRpcErrorCode.ServiceUnavailable),
    );

    const result = await runToolContract(guardianGetArticle, { article_id: 'world/2024/x' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: 'api_error',
      recovery: declaredRecovery(guardianGetArticle.errors, 'api_error'),
    });
  });

  it('guardian_browse_content section_not_found (upstream 404) carries the tool-declared recovery', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(httpFailure(404, JsonRpcErrorCode.NotFound));

    const result = await runToolContract(guardianBrowseContent, {
      mode: 'section_latest',
      section_id: 'nonexistent',
    });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.NotFound,
      reason: 'section_not_found',
      recovery: declaredRecovery(guardianBrowseContent.errors, 'section_not_found'),
    });
  });

  it('guardian_browse_content unauthorized on list_sections carries the tool-declared recovery', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
      httpFailure(401, JsonRpcErrorCode.Unauthorized),
    );

    const result = await runToolContract(guardianBrowseContent, { mode: 'list_sections' });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.Unauthorized,
      reason: 'unauthorized',
      recovery: declaredRecovery(guardianBrowseContent.errors, 'unauthorized'),
    });
  });

  it('guardian_browse_content api_error on list_tags carries the tool-declared recovery', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(
      httpFailure(503, JsonRpcErrorCode.ServiceUnavailable),
    );

    const result = await runToolContract(guardianBrowseContent, {
      mode: 'list_tags',
      query: 'climate',
    });

    expectContractFailure(result, {
      code: JsonRpcErrorCode.ServiceUnavailable,
      reason: 'api_error',
      recovery: declaredRecovery(guardianBrowseContent.errors, 'api_error'),
    });
  });
});
