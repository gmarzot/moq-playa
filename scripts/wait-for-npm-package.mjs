#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const retryable = new Set(['E404', 'ETARGET', 'E408', 'E429', 'E500', 'E502', 'E503', 'E504',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'FETCH_ERROR',
  'ECONNECTIONTIMEOUT', 'EIDLETIMEOUT', 'ERESPONSETIMEOUT', 'ETRANSFERTIMEOUT']);

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function main() {
  const spec = process.argv[2];
  const match = /^(@(?:openmoq|moqt|playa)\/[a-z0-9._-]+)@(\d+\.\d+\.\d+)$/.exec(spec ?? '');
  if (!match || process.argv.length !== 3) throw new Error('Expected one exact release package, such as @openmoq/player@0.6.1');
  const waitMs = positiveInteger('NPM_PACKAGE_WAIT_MS', 600_000);
  const pollMs = positiveInteger('NPM_PACKAGE_POLL_MS', 10_000);
  const deadline = performance.now() + waitMs;
  const directory = await mkdtemp(join(tmpdir(), 'moq-npm-download-'));
  let lastCode = 'not checked';
  try {
    while (performance.now() < deadline) {
      let stdout;
      try {
        // A private cache proves registry availability, not reuse of the tarball
        // that was just built locally. npm also checks the downloaded integrity.
        ({ stdout } = await run('npm', ['pack', spec, '--ignore-scripts', '--json',
          '--registry=https://registry.npmjs.org/', '--prefer-online', '--fetch-retries=0',
          '--fetch-timeout=20000', '--cache', join(directory, 'cache'), '--pack-destination', directory], {
          encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
          timeout: Math.max(1, Math.min(30_000, Math.ceil(deadline - performance.now()))),
          killSignal: 'SIGKILL',
        }));
      } catch (error) {
        let code = error.killed ? 'ETIMEDOUT' : error.code;
        try { code = JSON.parse(error.stdout).error?.code ?? code; } catch { /* npm may fail before producing JSON. */ }
        if (!retryable.has(code)) throw new Error(`Cannot download ${spec}: ${code ?? error.message}`);
        lastCode = code;
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        console.log(`Waiting for ${spec} to be downloadable (${code})`);
        await sleep(Math.min(pollMs, remaining));
        continue;
      }
      const packed = JSON.parse(stdout);
      if (!Array.isArray(packed) || packed.length !== 1 || packed[0]?.name !== match[1] || packed[0]?.version !== match[2]) {
        throw new Error(`npm downloaded a different package than ${spec}`);
      }
      console.log(`Download verified: ${spec}`);
      return;
    }
    throw new Error(`Timed out after ${waitMs}ms waiting for ${spec} (${lastCode})`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
