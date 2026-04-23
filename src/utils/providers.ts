import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ProviderName = 'codex' | 'claude';
export type ClaudeAuthMode =
  | 'auto'
  | 'interactive'
  | 'api-key'
  | 'auth-token'
  | 'oauth-token'
  | 'bedrock'
  | 'vertex'
  | 'foundry';

const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonFile(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isProviderName(value: unknown): value is ProviderName {
  return value === 'codex' || value === 'claude';
}

export function isClaudeAuthMode(value: unknown): value is ClaudeAuthMode {
  return typeof value === 'string' && [
    'auto',
    'interactive',
    'api-key',
    'auth-token',
    'oauth-token',
    'bedrock',
    'vertex',
    'foundry',
  ].includes(value);
}

export function detectBinary(binary: string, versionFlag = '--version'): boolean {
  const result = spawnSync(binary, [versionFlag], {
    stdio: 'ignore',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });

  return result.error === undefined && result.status !== null;
}

export function detectAvailableProviders(): ProviderName[] {
  const providers: ProviderName[] = [];

  if (detectBinary('codex')) {
    providers.push('codex');
  }

  if (detectBinary('claude', '-v')) {
    providers.push('claude');
  }

  return providers;
}

export function detectClaudeAuthModes(
  baseEnv: NodeJS.ProcessEnv = process.env,
): ClaudeAuthMode[] {
  const modes = new Set<ClaudeAuthMode>();

  if (baseEnv.CLAUDE_CODE_USE_BEDROCK === '1') {
    modes.add('bedrock');
  }
  if (baseEnv.CLAUDE_CODE_USE_VERTEX === '1') {
    modes.add('vertex');
  }
  if (baseEnv.CLAUDE_CODE_USE_FOUNDRY === '1') {
    modes.add('foundry');
  }
  if (typeof baseEnv.ANTHROPIC_API_KEY === 'string' && baseEnv.ANTHROPIC_API_KEY.trim()) {
    modes.add('api-key');
  }
  if (typeof baseEnv.ANTHROPIC_AUTH_TOKEN === 'string' && baseEnv.ANTHROPIC_AUTH_TOKEN.trim()) {
    modes.add('auth-token');
  }
  if (typeof baseEnv.CLAUDE_CODE_OAUTH_TOKEN === 'string' && baseEnv.CLAUDE_CODE_OAUTH_TOKEN.trim()) {
    modes.add('oauth-token');
  }

  const settings = parseJsonFile(CLAUDE_SETTINGS_PATH);
  if (settings && typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim()) {
    modes.add('api-key');
  }

  const credentials = parseJsonFile(CLAUDE_CREDENTIALS_PATH);
  if (credentials && Object.keys(credentials).length > 0) {
    modes.add('interactive');
  }

  if (detectBinary('claude', '-v')) {
    const status = spawnSync('claude', ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...baseEnv,
        NO_COLOR: '1',
      },
      encoding: 'utf-8',
    });

    if (status.status === 0) {
      try {
        const parsed = JSON.parse(status.stdout) as unknown;
        if (isRecord(parsed)) {
          modes.add('interactive');
        }
      } catch {
        modes.add('interactive');
      }
    }
  }

  return [...modes];
}

function stripClaudeAuth(env: NodeJS.ProcessEnv): void {
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
}

export function applyClaudeAuthMode(
  baseEnv: NodeJS.ProcessEnv,
  authMode: ClaudeAuthMode,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };

  if (authMode === 'auto') {
    return env;
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  const authToken = env.ANTHROPIC_AUTH_TOKEN;
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN;

  stripClaudeAuth(env);

  switch (authMode) {
    case 'interactive':
      return env;
    case 'api-key':
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      return env;
    case 'auth-token':
      if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
      return env;
    case 'oauth-token':
      if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      return env;
    case 'bedrock':
      env.CLAUDE_CODE_USE_BEDROCK = '1';
      return env;
    case 'vertex':
      env.CLAUDE_CODE_USE_VERTEX = '1';
      return env;
    case 'foundry':
      env.CLAUDE_CODE_USE_FOUNDRY = '1';
      return env;
    default:
      return env;
  }
}

export function applyClaudeAuthModeToProcess(authMode: ClaudeAuthMode): void {
  const nextEnv = applyClaudeAuthMode(process.env, authMode);

  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]) {
    if (!(key in nextEnv)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(nextEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}
