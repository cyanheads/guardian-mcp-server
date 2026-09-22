/**
 * @fileoverview Integration test for the server's declared HTTP session posture — boots
 * `src/index.ts` over HTTP and reads the resolved mode off the `/.well-known/mcp.json`
 * server card, covering the `createApp({ sessionMode })` default and the
 * `MCP_SESSION_MODE` precedence rules around it.
 * @module tests/integration/session-mode.test
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SESSION_MODE_META_KEY = 'io.github.cyanheads.mcp-ts-core/sessionMode';
/** What an MCPB or plugin host forwards when nothing substitutes the placeholder. */
const UNSUBSTITUTED_PLACEHOLDER = `\${MCP_SESSION_MODE}`;
const ENTRY = new URL('../../src/index.ts', import.meta.url).pathname;
const STARTUP_DEADLINE_MS = 15_000;

interface ServerCard {
  _meta?: Record<string, unknown>;
}

const running: ChildProcess[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(stop));
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Ask the OS for a free TCP port on the loopback interface. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not resolve a free port'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

/**
 * Start the server over HTTP with `MCP_SESSION_MODE` set to `sessionModeEnv`
 * (`undefined` removes it from the environment) and return the server card's
 * resolved session mode.
 */
async function resolvedSessionMode(sessionModeEnv: string | undefined): Promise<unknown> {
  const port = await freePort();
  /** Working directory and log dir — keeps Bun and dotenv from loading a developer's `.env`. */
  const scratchDir = mkdtempSync(join(tmpdir(), 'guardian-session-mode-'));
  scratchDirs.push(scratchDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GUARDIAN_API_KEY: 'test-key',
    MCP_TRANSPORT_TYPE: 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: String(port),
    MCP_LOG_LEVEL: 'error',
    LOGS_DIR: scratchDir,
  };
  delete env.MCP_SESSION_MODE;
  if (sessionModeEnv !== undefined) env.MCP_SESSION_MODE = sessionModeEnv;

  const child = spawn('bun', [ENTRY], {
    cwd: scratchDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  running.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with code ${child.exitCode} before serving:\n${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/mcp.json`);
      if (response.ok) {
        const card = (await response.json()) as ServerCard;
        return card._meta?.[SESSION_MODE_META_KEY];
      }
    } catch {
      // Not listening yet — poll again.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not serve its card within ${STARTUP_DEADLINE_MS} ms:\n${stderr}`);
}

describe('HTTP session mode', { timeout: 30_000 }, () => {
  it('resolves to stateless when MCP_SESSION_MODE is not set', async () => {
    expect(await resolvedSessionMode(undefined)).toBe('stateless');
  });

  it('falls through to stateless when MCP_SESSION_MODE is empty', async () => {
    expect(await resolvedSessionMode('')).toBe('stateless');
  });

  it('falls through to stateless when MCP_SESSION_MODE is an unsubstituted placeholder', async () => {
    expect(await resolvedSessionMode(UNSUBSTITUTED_PLACEHOLDER)).toBe('stateless');
  });

  it('lets an exported MCP_SESSION_MODE override the declared default', async () => {
    expect(await resolvedSessionMode('stateful')).toBe('stateful');
  });
});
