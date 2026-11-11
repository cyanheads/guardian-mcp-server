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
  skills: 'skills',
  resources: [],
  prompts: [],
  instructions:
    "Search The Guardian's archive with guardian_search_articles or discover filter IDs with guardian_browse_content in list_sections or list_tags mode. Use guardian_get_article with a result's exact ID or Guardian article URL for the complete available text. GUARDIAN_API_KEY is required. The free key is for non-commercial use. Pace requests to the configured key's limits. Powered by The Guardian.",

  setup(core) {
    getServerConfig();
    initGuardianService();
    core.logger.info('GuardianService initialized');
  },
});
