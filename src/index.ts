#!/usr/bin/env node
/**
 * @fileoverview guardian-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { guardianBrowse } from './mcp-server/tools/definitions/guardian-browse.tool.js';
import { guardianGetArticle } from './mcp-server/tools/definitions/guardian-get-article.tool.js';
import { guardianSearch } from './mcp-server/tools/definitions/guardian-search.tool.js';
import { initGuardianService } from './services/guardian/guardian-service.js';

await createApp({
  name: 'guardian-mcp-server',
  title: 'guardian-mcp-server',
  tools: [guardianSearch, guardianGetArticle, guardianBrowse],
  resources: [],
  prompts: [],
  instructions:
    "Guardian Open Platform MCP server. Provides full article text — not just headlines — from The Guardian's archive (1999–present). " +
    'GUARDIAN_API_KEY is required (free non-commercial key at open-platform.theguardian.com). ' +
    'Typical workflows: guardian_search for archive search → guardian_get_article for full text; guardian_browse mode=list_sections or list_tags to discover valid filter IDs. ' +
    'Rate limits: 5,000 requests/day, 12 calls/sec (free tier). Powered by The Guardian.',

  setup(core) {
    initGuardianService();
    core.logger.info('GuardianService initialized');
  },
});
