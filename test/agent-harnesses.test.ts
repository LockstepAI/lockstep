import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  chmodSync(path, 0o755);
  return path;
}

function makeCaptureScript(
  dir: string,
  name: string,
  stdout: string,
): {
  binDir: string;
  argsPath: string;
  stdinPath: string;
  scriptPath: string;
} {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const argsPath = join(dir, `${name}.args`);
  const stdinPath = join(dir, `${name}.stdin`);

  const scriptPath = writeExecutable(
    binDir,
    name,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_ARGS_PATH"
cat > "$FAKE_STDIN_PATH"
cat <<'EOF'
${stdout}
EOF
`,
  );

  return { binDir, argsPath, stdinPath, scriptPath };
}

async function importFresh<T>(specifier: string): Promise<T> {
  vi.resetModules();
  return import(specifier) as Promise<T>;
}

function setCaptureEnv(capture: {
  binDir: string;
  argsPath: string;
  stdinPath: string;
}): void {
  process.env.PATH = `${capture.binDir}${delimiter}${process.env.PATH ?? ''}`;
  process.env.FAKE_ARGS_PATH = capture.argsPath;
  process.env.FAKE_STDIN_PATH = capture.stdinPath;
}

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();

  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }

  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('CodexAgent', () => {
  it('sends prompts over stdin with the standard unattended flags', async () => {
    const dir = makeTempDir('lockstep-agent-codex-');
    TEMP_DIRS.push(dir);
    const capture = makeCaptureScript(dir, 'codex', 'codex-ok');
    setCaptureEnv(capture);
    process.env.CODEX_BIN = capture.scriptPath;

    const { CodexAgent } = await importFresh<typeof import('../src/agents/codex.js')>(
      '../src/agents/codex.js',
    );

    const result = await new CodexAgent().execute('reply with ok', {
      workingDirectory: dir,
      timeout: 5_000,
      model: 'gpt-5.4',
    });

    expect(result.success).toBe(true);
    expect(readFileSync(capture.stdinPath, 'utf-8')).toBe('reply with ok');

    const args = readFileSync(capture.argsPath, 'utf-8').trim().split('\n');
    expect(args).toContain('exec');
    expect(args).toContain('--full-auto');
    expect(args).toContain('--json');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--color');
    expect(args).toContain('never');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain('--cd');
    expect(args).toContain(dir);
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.4');
    expect(args[args.length - 1]).toBe('-');
  });

  it('switches to the unsandboxed yolo flag when requested', async () => {
    const dir = makeTempDir('lockstep-agent-codex-yolo-');
    TEMP_DIRS.push(dir);
    const capture = makeCaptureScript(dir, 'codex', 'codex-yolo-ok');
    setCaptureEnv(capture);
    process.env.CODEX_BIN = capture.scriptPath;

    const { CodexAgent } = await importFresh<typeof import('../src/agents/codex.js')>(
      '../src/agents/codex.js',
    );

    const result = await new CodexAgent().execute('reply with ok', {
      workingDirectory: dir,
      timeout: 5_000,
      executionMode: 'yolo',
    });

    expect(result.success).toBe(true);

    const args = readFileSync(capture.argsPath, 'utf-8').trim().split('\n');
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
  });

  it('blocks disallowed file changes from Codex JSON events using the policy engine', async () => {
    const dir = makeTempDir('lockstep-agent-codex-policy-');
    TEMP_DIRS.push(dir);

    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const argsPath = join(dir, 'codex.args');
    const stdinPath = join(dir, 'codex.stdin');
    const blockedPath = join(dir, 'secret.txt');
    const scriptPath = writeExecutable(
      binDir,
      'codex',
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_ARGS_PATH"
cat > "$FAKE_STDIN_PATH"
cat <<'EOF'
{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"${blockedPath}","kind":"add"}],"status":"in_progress"}}
EOF
sleep 5
`,
    );

    setCaptureEnv({ binDir, argsPath, stdinPath });
    process.env.CODEX_BIN = scriptPath;

    const { CodexAgent } = await importFresh<typeof import('../src/agents/codex.js')>(
      '../src/agents/codex.js',
    );

    const result = await new CodexAgent().execute('create the file', {
      workingDirectory: dir,
      timeout: 10_000,
      policy: {
        filesystem: {
          protected: ['secret.txt'],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Policy blocked Write action');
    expect(result.stderr).toContain('lockstep approve');
  });

  it('routes Codex package-manager state into the workspace-local tool cache', async () => {
    const dir = makeTempDir('lockstep-agent-codex-env-');
    TEMP_DIRS.push(dir);

    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const argsPath = join(dir, 'codex.args');
    const stdinPath = join(dir, 'codex.stdin');
    const envPath = join(dir, 'codex.env');
    const scriptPath = writeExecutable(
      binDir,
      'codex',
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$FAKE_ARGS_PATH"
cat > "$FAKE_STDIN_PATH"
cat > "$FAKE_ENV_PATH" <<EOF
XDG_DATA_HOME=$XDG_DATA_HOME
COREPACK_HOME=$COREPACK_HOME
PNPM_HOME=$PNPM_HOME
npm_config_cache=$npm_config_cache
pnpm_config_store_dir=$pnpm_config_store_dir
EOF
cat <<'EOF'
{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}
EOF
`,
    );

    setCaptureEnv({ binDir, argsPath, stdinPath });
    process.env.CODEX_BIN = scriptPath;
    process.env.FAKE_ENV_PATH = envPath;

    const { CodexAgent } = await importFresh<typeof import('../src/agents/codex.js')>(
      '../src/agents/codex.js',
    );

    const result = await new CodexAgent().execute('show env', {
      workingDirectory: dir,
      timeout: 5_000,
    });

    expect(result.success).toBe(true);

    const envLines = readFileSync(envPath, 'utf-8').trim().split('\n');
    const entries = Object.fromEntries(envLines.map((line) => {
      const [key, value] = line.split('=', 2);
      return [key, value];
    }));

    expect(entries.XDG_DATA_HOME).toBe(join(dir, '.lockstep-tools', 'xdg-data'));
    expect(entries.COREPACK_HOME).toBe(join(dir, '.lockstep-tools', 'corepack'));
    expect(entries.PNPM_HOME).toBe(join(dir, '.lockstep-tools', 'pnpm-home'));
    expect(entries.npm_config_cache).toBe(join(dir, '.lockstep-tools', 'npm-cache'));
    expect(entries.pnpm_config_store_dir).toBe(join(dir, '.lockstep-tools', 'pnpm-store'));
  });
});

describe('ClaudeAgent', () => {
  it('uses documented Claude CLI flags and provider-default model behavior', async () => {
    const dir = makeTempDir('lockstep-agent-claude-');
    TEMP_DIRS.push(dir);
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const argsPath = join(dir, 'claude.args');
    const settingsCopyPath = join(dir, 'claude.settings.json');
    const scriptPath = writeExecutable(
      binDir,
      'claude',
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_ARGS_PATH"
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" == "--settings" ]]; then
    next=$((i + 1))
    cp "\${!next}" "$FAKE_SETTINGS_COPY_PATH"
    break
  fi
done
cat <<'EOF'
claude-ok
EOF
`,
    );
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
    process.env.FAKE_ARGS_PATH = argsPath;
    process.env.FAKE_SETTINGS_COPY_PATH = settingsCopyPath;
    process.env.CLAUDE_BIN = scriptPath;

    const { ClaudeAgent } = await importFresh<typeof import('../src/agents/claude.js')>(
      '../src/agents/claude.js',
    );

    const result = await new ClaudeAgent().execute('ship the change', {
      workingDirectory: dir,
      timeout: 5_000,
      effortLevel: 'high',
      model: 'sonnet',
    });

    expect(result.success).toBe(true);

    const args = readFileSync(argsPath, 'utf-8').trim().split('\n');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('text');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(args).toContain('--tools');
    expect(args).toContain('Bash,Read,Edit,Write,Glob,Grep,LSP,TodoWrite');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('dontAsk');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args[args.length - 1]).toBe('ship the change');

    const settingsIndex = args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThan(-1);
    const settings = JSON.parse(readFileSync(settingsCopyPath, 'utf-8')) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toContain('Bash');
    expect(settings.permissions?.allow).toContain('Write');
  });

  it('switches Claude into bypass permissions mode for yolo runs', async () => {
    const dir = makeTempDir('lockstep-agent-claude-yolo-');
    TEMP_DIRS.push(dir);
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const argsPath = join(dir, 'claude.args');
    const settingsCopyPath = join(dir, 'claude.settings.json');
    const scriptPath = writeExecutable(
      binDir,
      'claude',
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_ARGS_PATH"
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" == "--settings" ]]; then
    next=$((i + 1))
    cp "\${!next}" "$FAKE_SETTINGS_COPY_PATH"
    break
  fi
done
cat <<'EOF'
claude-yolo-ok
EOF
`,
    );
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
    process.env.FAKE_ARGS_PATH = argsPath;
    process.env.FAKE_SETTINGS_COPY_PATH = settingsCopyPath;
    process.env.CLAUDE_BIN = scriptPath;

    const { ClaudeAgent } = await importFresh<typeof import('../src/agents/claude.js')>(
      '../src/agents/claude.js',
    );

    const result = await new ClaudeAgent().execute('ship the change', {
      workingDirectory: dir,
      timeout: 5_000,
      executionMode: 'yolo',
    });

    expect(result.success).toBe(true);

    const args = readFileSync(argsPath, 'utf-8').trim().split('\n');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
  });
});
