import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const CLI = 'npx tsx src/bin/lockstep.ts';

describe('CLI smoke tests', () => {
  it('--version returns a version string', () => {
    const out = execSync(`${CLI} --version`, { encoding: 'utf-8' }).trim();
    // The version may be a semver string or "unknown" depending on package.json name resolution
    expect(out).toMatch(/^(\d+\.\d+\.\d+|unknown)/);
  });

  it('--help shows commands', () => {
    const out = execSync(`${CLI} --help`, { encoding: 'utf-8' });
    expect(out).toContain('run');
    expect(out).toContain('validate');
    expect(out).toContain('verify');
    expect(out).toContain('review');
    expect(out).toContain('policy');
    expect(out).toContain('contract');
  });

  it('templates command lists templates', () => {
    const out = execSync(`${CLI} templates`, { encoding: 'utf-8' });
    expect(out).toContain('blank');
    expect(out).toContain('nextjs-saas');
    expect(out).toContain('rest-api');
    expect(out).toContain('solana-program');
  });

  it('validate accepts blank template', () => {
    const out = execSync(`${CLI} validate templates/blank.yml`, { encoding: 'utf-8' });
    expect(out).toContain('Valid');
  });

  it('validate accepts all templates', () => {
    const templates = ['blank', 'nextjs-saas', 'rest-api', 'solana-program'];
    for (const t of templates) {
      const out = execSync(`${CLI} validate templates/${t}.yml`, { encoding: 'utf-8' });
      expect(out).toContain('Valid');
    }
  });

  it('validate rejects invalid spec', () => {
    expect(() => {
      execSync(`${CLI} validate /dev/null`, { encoding: 'utf-8', stdio: 'pipe' });
    }).toThrow();
  });

  it('review works without a local spec file', () => {
    const out = execSync(`${CLI} review /tmp/definitely-missing-lockstep.yml`, { encoding: 'utf-8' });
    expect(out).toContain('Lockstep Review');
    expect(out).toContain('No spec found');
  });
});
