#!/usr/bin/env node
/**
 * @fileoverview guardian-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { guardianBrowseContent } from './mcp-server/tools/definitions/guardian-browse-content.tool.js';
import { guardianGetArticle } from './mcp-server/tools/definitions/guardian-get-article.tool.js';
import { guardianSearchArticles } from './mcp-server/tools/definitions/guardian-search-articles.tool.js';
import { initGuardianService } from './services/guardian/guardian-service.js';

await createApp({
  name: 'guardian-mcp-server',
  title: 'guardian-mcp-server',
  sessionMode: 'stateless',
  tools: [guardianSearchArticles, guardianGetArticle, guardianBrowseContent],
  resources: [],
  prompts: [],
  instructions:
    "Guardian Open Platform MCP server. Provides full article text — not just headlines — from The Guardian's archive (1999–present). " +
    'GUARDIAN_API_KEY is required (free non-commercial key at open-platform.theguardian.com). ' +
    'Typical workflows: guardian_search_articles for archive search → guardian_get_article for full text; guardian_browse_content mode=list_sections or list_tags to discover valid filter IDs. ' +
    'Search and browse return 2,000-word previews; guardian_get_article returns complete text using article_id. ' +
    'Rate limits: 5,000 requests/day, 12 calls/sec (free tier). Powered by The Guardian.',

  setup(core) {
    getServerConfig();
    initGuardianService();
    core.logger.info('GuardianService initialized');
  },
});
