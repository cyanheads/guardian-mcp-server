/**
 * @fileoverview Server-specific configuration — parses GUARDIAN_API_KEY from the environment.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .min(1)
    .describe(
      'Guardian Open Platform API key. Free (non-commercial) key available at ' +
        'open-platform.theguardian.com. Commercial use requires a separate Guardian agreement.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns parsed server config, initializing on first call. Throws ConfigurationError on missing vars. */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'GUARDIAN_API_KEY',
  });
  return _config;
}
