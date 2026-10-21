#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
const releaseOnly = new Set([
  '.github/workflows/publish.yml',
  'scripts/publish-order.test.ts',
  'scripts/validate-release-source.mjs',
  'scripts/validate-release-source.test.ts',
  'scripts/wait-for-npm-package.mjs',
]);

try {
  const tag = process.env.RELEASE_TAG;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Release tag must be vMAJOR.MINOR.PATCH');
  const head = git('rev-parse', 'HEAD').trim();
  const tagged = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`).trim();
  if (head !== process.env.GITHUB_SHA) throw new Error('Checkout does not match the source recorded in npm provenance');
  git('merge-base', '--is-ancestor', head, 'origin/main');
  git('merge-base', '--is-ancestor', tagged, head);
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Release checkout must be clean');

  if (process.env.GITHUB_EVENT_NAME === 'push') {
    if (process.env.GITHUB_REF !== `refs/tags/${tag}` || head !== tagged) throw new Error('Tag push must build the tagged commit');
  } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Release resumes must run from main');
    // Keep the checkout at GITHUB_SHA so npm provenance names the actual build
    // source. Only release infrastructure may differ from the immutable tag.
    const changed = git('diff', '--name-only', '--no-renames', '-z', tagged, head, '--').split('\0').filter(Boolean);
    const disallowed = changed.filter((path) => !releaseOnly.has(path));
    if (disallowed.length) throw new Error(`Release inputs differ from ${tag}: ${disallowed.join(', ')}`);
  } else {
    throw new Error('Release requires a tag push or an explicit workflow dispatch');
  }
  console.log(`Release tag: ${tag} (${tagged})`);
  console.log(`Build source: ${head}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
