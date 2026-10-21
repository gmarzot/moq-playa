import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, 'validate-release-source.mjs');

describe('release source validation', () => {
  it.each([
    'tag push', 'resume', 'package changed', 'lockfile changed', 'build script changed',
    'other branch', 'wrong checkout', 'wrong tag', 'unreachable tag', 'untracked input', 'dirty input',
    'whitespace path', 'head outside main', 'wrong push checkout', 'unsupported event',
  ] as const)('%s', (condition) => {
    const directory = mkdtempSync(join(tmpdir(), 'moq-release-source-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
    const put = (path: string, value: string) => {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), value);
    };
    const commit = () => {
      git('add', '.');
      git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
      return git('rev-parse', 'HEAD');
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      put('packages/player/src/index.ts', 'export const version = "0.6.1";\n');
      const tagged = commit();
      git('tag', 'v0.6.1');
      if (condition !== 'tag push') {
        put('.github/workflows/publish.yml', 'name: publish\n');
        put('scripts/wait-for-npm-package.mjs', '// Release helper\n');
      }
      if (condition === 'package changed') put('packages/player/src/index.ts', 'export const version = "other";\n');
      if (condition === 'lockfile changed') put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
      if (condition === 'build script changed') put('scripts/generate-package-readmes.mjs', '// Changed build input\n');
      if (condition === 'whitespace path') put(' scripts/wait-for-npm-package.mjs', '// Not the allowed path\n');
      const head = condition === 'tag push' ? tagged : commit();
      git('update-ref', 'refs/remotes/origin/main', condition === 'head outside main' ? tagged : head);
      if (condition === 'unreachable tag') {
        git('checkout', '-q', '--orphan', 'elsewhere');
        const unrelated = commit();
        git('tag', '-f', 'v0.6.1', unrelated);
        git('checkout', '-q', 'main');
      }
      if (condition === 'untracked input') put('packages/player/src/extra.ts', 'export {};\n');
      if (condition === 'dirty input') put('packages/player/src/index.ts', 'export {};\n');
      const run = () => execFileSync(process.execPath, [script], {
        cwd: directory,
        env: {
          ...process.env,
          RELEASE_TAG: condition === 'wrong tag' ? 'v0.6.1;echo invalid' : 'v0.6.1',
          GITHUB_EVENT_NAME: ['tag push', 'wrong push checkout'].includes(condition) ? 'push'
            : condition === 'unsupported event' ? 'pull_request' : 'workflow_dispatch',
          GITHUB_REF: ['tag push', 'wrong push checkout'].includes(condition) ? 'refs/tags/v0.6.1'
            : condition === 'other branch' ? 'refs/heads/other' : 'refs/heads/main',
          GITHUB_SHA: condition === 'wrong checkout' ? tagged : head,
        },
        stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
      });
      if (condition === 'tag push' || condition === 'resume') {
        expect(run()).toContain(`Build source: ${head}`);
        expect(git('rev-parse', 'v0.6.1')).toBe(tagged);
      } else expect(run).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resumes from main without checking out a different source than provenance records', () => {
    const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/publish.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("group: publish-refs/tags/${{ inputs.tag || github.ref_name }}");
    expect(workflow).toContain('RELEASE_TAG: ${{ inputs.tag || github.ref_name }}');
    expect(workflow).toContain('run: node scripts/validate-release-source.mjs');
    expect(workflow).not.toMatch(/ref:.*inputs\.tag/);
    expect(workflow).toContain('tag="${RELEASE_TAG}"');
  });
});
