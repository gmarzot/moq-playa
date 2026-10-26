/**
 * Player soak: plays live streams in headless Chrome for minutes per case and
 * records whole-run QoE (scripts/player-soak/README.md).
 *
 *   --mtt [--only RELAY:PACKAGING,…]   moq-test-tracks streams, started through its API (MTT_API_KEY)
 *   --broadcaster RELAY:PACKAGING  publish a synthetic g5-broadcast for --minutes + --lead-minutes
 *   --broadcast-player RELAY:PACKAGING[,…]   wait for each broadcast in turn and play it
 *   --profile NAME   play under an adverse profile from cases.json (network shaping, blackouts,
 *                    hidden tab, publisher restarts); first play draft only
 *   --variant restart   the broadcaster restarts every cases.restartEveryS; players use its namespace
 *   --adverse-minutes M   keep a broadcaster up for the adverse players too
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { MttClient } from './mtt.mjs';
import { assessSoak } from './assess.mjs';
import { prepareCamera } from './fixture.mjs';
import { Impairment } from './impair.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values: args } = parseArgs({ options: {
  cases: { type: 'string', default: join(root, 'scripts/player-soak/cases.json') },
  minutes: { type: 'string', default: '5' },
  mtt: { type: 'boolean', default: false },
  only: { type: 'string' },
  concurrency: { type: 'string', default: '2' },
  broadcaster: { type: 'string' },
  'broadcast-player': { type: 'string' },
  'lead-minutes': { type: 'string', default: '10' },
  'wait-s': { type: 'string', default: '420' },
  tag: { type: 'string', default: process.env.SOAK_TAG ?? randomUUID().slice(0, 8) },
  'skip-build': { type: 'boolean', default: false },
  profile: { type: 'string' },
  variant: { type: 'string' },
  'adverse-minutes': { type: 'string', default: '0' },
} });

const minutes = Number(args.minutes);
const tag = args.tag.replace(/[^a-z0-9]/gi, '').toLowerCase();
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}`;
const out = resolve(root, 'reports/player-soak', runId);
const children = new Set();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const json = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

function launch(name, command, argv, cwd = root) {
  const logFile = createWriteStream(join(out, `${name}.log`));
  const child = spawn(command, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const state = { child, text: '' };
  children.add(state);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => {
    logFile.write(b);
    state.text = (state.text + b.toString()).slice(-65536);
  });
  state.done = new Promise((res) => child.once('close', res));
  return state;
}

async function waitForLine(state, pattern, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const match = pattern.exec(state.text);
    if (match) return match[1];
    if (Date.now() > end) throw new Error(`no ${pattern} within ${ms} ms:\n${state.text.slice(-2000)}`);
    await sleep(100);
  }
}

async function buildOnce() {
  if (args['skip-build']) return;
  const build = launch('build', 'pnpm', ['-r', 'build']);
  if (await build.done !== 0) throw new Error(`build failed:\n${build.text.slice(-4000)}`);
}

async function startPages() {
  const vite = launch('vite', process.execPath, ['_tests/player-acceptance/serve.mjs'], join(root, 'examples'));
  return waitForLine(vite, /Acceptance page: (http:\/\/127\.0\.0\.1:\d+\/)/);
}

const browserArgs = ['--autoplay-policy=no-user-gesture-required'];

/**
 * Hide or show the player's tab: a page brought to front over it, or, where
 * headless Chrome keeps the covered page visible, an emulated visibility state.
 */
async function setHidden(context, page, hidden, state) {
  if (hidden) {
    state.cover = await context.newPage();
    await state.cover.bringToFront();
    state.method = await page.evaluate(() => document.visibilityState) === 'hidden' ? 'covered' : 'emulated';
  } else {
    await page.bringToFront();
    await state.cover?.close();
    state.cover = null;
  }
  if (state.method !== 'emulated') return;
  await page.evaluate((h) => {
    if (h) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    } else {
      delete document.visibilityState;
      delete document.hidden;
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Start a profile event; resolves to its record, which `stop` completes. */
async function startDisruption(e, { impair, context, page }) {
  if (e.blackoutS) {
    if (!impair) throw new Error('blackout needs network shaping');
    await impair.blackout();
    return { kind: 'blackout', plannedMs: e.blackoutS * 1000, startEpochMs: Date.now(),
      stop: () => impair.restore() };
  }
  if (e.hiddenS) {
    const state = {};
    await setHidden(context, page, true, state);
    return { kind: 'hidden', method: state.method, plannedMs: e.hiddenS * 1000, startEpochMs: Date.now(),
      stop: () => setHidden(context, page, false, state) };
  }
  throw new Error(`unknown profile event ${JSON.stringify(e)}`);
}

/** Play one stream for `minutes` and write its observation stream and summary. */
async function playCase(browser, webUrl, c, impair = null) {
  const dir = join(out, c.name);
  await mkdir(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleFile = join(dir, 'console.jsonl');
  page.on('console', (m) => void appendFile(consoleFile, `${json({ t: Date.now(), type: m.type(), text: m.text() })}\n`));
  page.on('pageerror', (e) => void appendFile(consoleFile, `${json({ t: Date.now(), type: 'pageerror', text: e.message })}\n`));
  // Viewers start as G5 does: from the current group.
  const query = new URLSearchParams({ url: c.url, ns: c.namespace, v: String(c.draft), soak: '1', warmStart: '1' });
  if (c.packaging === 'loc') query.set('output', 'canvas');
  if (c.packaging === 'locmaf') query.set('locmaf', 'mse');
  const startup = { attempts: 0 };
  const deadline = Date.now() + (c.waitS ?? 60) * 1000;
  try {
    for (;;) {
      startup.attempts++;
      await page.goto(`${webUrl}_tests/player-acceptance/?${query}`, { waitUntil: 'domcontentloaded' });
      const clickedAt = Date.now();
      await page.locator('#start').click();
      try {
        await page.waitForFunction(() => {
          const s = window.playerAcceptance;
          if (s?.startupError) throw new Error(s.startupError);
          return s?.presentedFrames >= 8 && s.currentTime > 0.1;
        }, null, { timeout: 30_000 });
        startup.readyMs = Date.now() - clickedAt;
        break;
      } catch (error) {
        startup.lastError = String(error).slice(0, 300);
        if (Date.now() + 10_000 > deadline) throw error;
        log(c.name, `not playing yet (attempt ${startup.attempts}); retrying`);
        await sleep(10_000);
      }
    }
    log(c.name, `playing after ${startup.readyMs} ms; observing for ${minutes} min`);
    await page.evaluate(() => window.playerAcceptance.begin(false));
    const samples = [];
    const ticks = [];
    const disruptions = [];
    const events = [...(c.profile?.events ?? [])];
    let active = null;
    const finishDisruption = async () => {
      const { stop, ...record } = active;
      active = null;
      await stop();
      disruptions.push({ ...record, endEpochMs: Date.now() });
    };
    const observedAt = Date.now();
    const end = observedAt + minutes * 60_000;
    let publisherEnded = null;
    while (Date.now() < end) {
      await sleep(1000);
      if (active && Date.now() - active.startEpochMs >= active.plannedMs) await finishDisruption();
      if (!active && events.length && Date.now() - observedAt >= events[0].atS * 1000) {
        active = await startDisruption(events.shift(), { impair, context, page });
        log(c.name, `${active.kind} for ${active.plannedMs} ms`);
      }
      const d = await page.evaluate(() => window.playerAcceptance.drain());
      samples.push(...d.samples);
      const tick = { wallEpochMs: d.wallEpochMs, state: d.state, stats: d.stats, latency: d.latency, events: d.events };
      ticks.push(tick);
      await appendFile(join(dir, 'samples.jsonl'), d.samples.map((s) => `${json(s)}\n`).join(''));
      await appendFile(join(dir, 'ticks.jsonl'), `${json(tick)}\n`);
      // The publisher ended the track (PUBLISH_DONE): stop rather than record a freeze.
      if (c.profile?.variant !== 'restart' && d.events.some((e) => e.type === 'track_unsubscribed'
          && !/resubscribe failed/.test(String(e.data?.reason ?? '')))) {
        publisherEnded = { atS: Math.round((Date.now() - observedAt) / 1000) };
        log(c.name, `publisher ended the track after ${publisherEnded.atS} s`);
        break;
      }
    }
    if (active) await finishDisruption();
    await page.evaluate(() => window.playerAcceptance.finish());
    if (impair) await writeFile(join(dir, 'tc.json'), `${json(await impair.stats())}\n`);
    const summary = { name: c.name, url: c.url, namespace: c.namespace, draft: c.draft, packaging: c.packaging,
      ...(c.profileName ? { profile: c.profileName } : {}),
      ...(publisherEnded ? { publisherEnded } : {}),
      ...assessSoak({ samples, ticks, expected: c.expected, startup, disruptions, adverse: Boolean(c.profile) }) };
    await writeFile(join(dir, 'summary.json'), `${json(summary)}\n`);
    return summary;
  } catch (error) {
    const summary = { name: c.name, url: c.url, namespace: c.namespace, draft: c.draft, packaging: c.packaging,
      verdict: 'error', error: String(error).slice(0, 500), startup };
    await writeFile(join(dir, 'summary.json'), `${json(summary)}\n`);
    return summary;
  } finally {
    await Promise.race([page.evaluate(() => window.playerAcceptance?.destroy()), sleep(10_000)]).catch(() => {});
    await context.close().catch(() => {});
  }
}

/** moq-test-tracks cases, one service job per stream, `concurrency` jobs at a time. */
async function runMtt(browser, webUrl, cases) {
  const client = new MttClient({ key: process.env.MTT_API_KEY, base: process.env.MTT_API_BASE });
  const groups = cases.mtt
    .filter((g) => !args.only || args.only.split(',').includes(`${g.relay}:${g.id ?? g.packaging}`))
    .map((g) => ({ ...g, relayInfo: cases.relays[g.relay],
      namespace: g.namespace ?? cases.mttNamespace.replace('{packaging}', g.packaging) }));
  const results = [];
  const queue = [...groups];
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const plays = g.relayInfo.playDrafts.map((draft) => ({
        name: `mtt-${g.id ?? g.packaging}-${g.relay}-d${draft}`, url: g.relayInfo.url, namespace: g.namespace, draft,
        packaging: g.packaging, expected: g.expected ?? cases.mttExpected,
      }));
      let job;
      try {
        const ttl = Math.ceil(plays.length * (minutes + 2) * 60) + 300;
        job = await client.start({ namespace: g.namespace, relay: g.relay, draft: g.relayInfo.publishDraft, mode: 'publish', ttl_s: ttl },
          { log: (m) => log(g.relay, g.packaging, m) });
        log(g.relay, g.packaging, `job ${job.id} ${job.joined ? 'joined' : 'started'}`);
        await client.waitRunning(job.id);
        for (const p of plays) results.push(await playCase(browser, webUrl, p));
      } catch (error) {
        for (const p of plays) results.push({ name: p.name, verdict: 'error', error: String(error).slice(0, 500) });
      } finally {
        if (job && !job.joined) await client.stop(job.id).catch((e) => log('stop failed', String(e)));
      }
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  return results;
}

function broadcastCase(cases, spec, variant) {
  const [relay, packaging] = spec.split(':');
  const relayInfo = cases.relays[relay];
  if (!relayInfo) throw new Error(`unknown relay ${relay}`);
  // One element per field, under a prefix that marks CI traffic on the public relays.
  const namespace = `ci/player-soak/${tag}/${relay}/${packaging}${variant ? `/${variant}` : ''}`;
  return { relay, packaging, relayInfo, namespace, spec };
}

/** Publish a synthetic g5-broadcast until the players have had their minutes. */
async function runBroadcaster(webUrl, b, totalMinutes, restartEveryS = 0) {
  const dir = join(out, `broadcaster-${b.packaging}-${b.relay}`);
  const camera = await prepareCamera(join(out, 'camera'));
  const browser = await chromium.launch({ channel: process.env.PLAYER_TEST_BROWSER ?? 'chrome', args: [...browserArgs,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${camera.video}`, `--use-file-for-fake-audio-capture=${camera.audio}`] });
  await mkdir(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('console', (m) => void appendFile(join(dir, 'console.jsonl'), `${json({ t: Date.now(), type: m.type(), text: m.text() })}\n`));
  const p = b.params;
  const query = new URLSearchParams({ url: b.relayInfo.url, ns: b.namespace, v: String(b.relayInfo.publishDraft),
    packaging: b.packaging, height: String(p.height), fps: String(p.fps), bitrate: String(p.bitrate), target: String(p.target),
    clockUrl: 'https://aiomoqt-relay.marzresearch.net/time' });
  let wentLive = false;
  try {
    await page.goto(`${webUrl}g5-broadcast/?${query}`, { waitUntil: 'domcontentloaded' });
    // Published once the relay accepts the namespace; "live" waits for a catalog subscriber,
    // which moqx-main sends only when a viewer arrives.
    const goLive = async () => {
      await page.locator('#start-camera').click();
      await page.waitForFunction(() => ['live', 'awaiting subscribe'].includes(document.querySelector('#state')?.textContent ?? ''),
        null, { timeout: 60_000 });
      return Date.now();
    };
    let liveAt = await goLive();
    wentLive = true;
    log('broadcaster', b.namespace, 'published');
    const end = Date.now() + totalMinutes * 60_000;
    while (Date.now() < end) {
      await sleep(5000);
      if (restartEveryS > 0 && Date.now() - liveAt >= restartEveryS * 1000) {
        const stoppedAt = Date.now();
        await page.locator('#stop').click();
        await page.waitForFunction(() => !document.querySelector('#start-camera')?.disabled, null, { timeout: 30_000 });
        liveAt = await goLive();
        log('broadcaster', b.namespace, `restarted: published again after ${liveAt - stoppedAt} ms`);
        await appendFile(join(dir, 'ticks.jsonl'), `${json({ t: liveAt, restart: { stoppedAt, liveAt } })}\n`);
      }
      const cells = await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        cells: Object.fromEntries([...document.querySelectorAll('#diag-grid .cell, #adv-grid .cell')]
          .map((c) => [c.firstChild?.textContent ?? '', c.querySelector('b')?.textContent ?? ''])),
      }));
      await appendFile(join(dir, 'ticks.jsonl'), `${json({ t: Date.now(), ...cells })}\n`);
    }
  } finally {
    // The page's own log is the only record of why a broadcast did not publish.
    const pageLog = await page.locator('#log').textContent().catch(() => null) ?? '';
    await writeFile(join(dir, 'log.txt'), pageLog);
    if (!wentLive) log('broadcaster', b.namespace, `never published; page log:\n${pageLog.slice(-2000)}`);
    await page.locator('#stop').click().catch(() => {});
    await sleep(1000);
    await browser.close();
  }
}

const recoveryCell = (rec) => {
  if (!rec || rec.events.length === 0) return '—';
  const flags = [rec.unrecovered ? `${rec.unrecovered} unrecovered` : '', rec.unsettled ? `${rec.unsettled} unsettled` : '']
    .filter(Boolean).join(', ');
  return `${rec.events.length}, ${rec.freshFrameAfterMsMax ?? '—'} / ${rec.stableLatencyAfterMsMax ?? '—'}${flags ? ` (${flags})` : ''}`;
};
const startupCell = (b) => (b ? [b.transportConnectedMs, b.setupCompleteMs, b.catalogReceivedMs, b.firstObjectReceivedMs,
  b.firstFrameRenderedMs].map((v) => (v == null ? '—' : Math.round(v))).join(' / ') : '—');

async function report(results) {
  const rows = results.map((r) => {
    const lat = Object.entries(r.latency ?? {}).find(([k]) => k.startsWith('video/'))?.[1];
    const pb = r.playback;
    return `| ${r.name} | ${r.verdict} | ${r.startup?.readyMs ?? '—'} | ${pb ? `${pb.stalls.count} / ${pb.stalls.totalMs} ms` : '—'} `
      + `| ${pb ? `${pb.frozen.count} / ${pb.audioGaps.count}` : '—'} | ${pb?.fps.mean ?? '—'} `
      + `| ${lat ? `${Math.round(lat.p50)} / ${Math.round(lat.p95)} / ${Math.round(lat.driftMs)}` : '—'} `
      + `| ${r.player ? `${r.player.framesDropped} / ${r.player.audioUnderruns}` : '—'} `
      + `| ${recoveryCell(r.recovery)} | ${startupCell(r.startup?.breakdownMs)} `
      + `| ${r.error ? r.error.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 80)
        : r.publisherEnded ? `publisher ended at ${r.publisherEnded.atS} s` : ''} |`;
  });
  const md = [`### Player soak ${runId} (${minutes} min per case)`, '',
    '| case | verdict | ready ms | stalls / time | frozen / audio gaps | fps | video latency p50 / p95 / drift ms '
      + '| dropped / underruns | recovery: events, max fresh / settled ms | startup: connect / setup / catalog / object / frame ms | error |',
    '|---|---|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
  await writeFile(join(out, 'summary.md'), md);
  await writeFile(join(out, 'summary.json'), `${json({ runId, minutes, results })}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
}

await mkdir(out, { recursive: true });
log(`soak evidence: ${out}`);
const cases = JSON.parse(await readFile(args.cases, 'utf8'));
let failed = false;
try {
  await buildOnce();
  const webUrl = await startPages();
  if (args.broadcaster) {
    const b = { ...broadcastCase(cases, args.broadcaster, args.variant), params: cases.broadcastParams };
    const adverseMinutes = Number(args['adverse-minutes']);
    const adverse = adverseMinutes > 0 && cases.adverse.broadcasts.includes(args.broadcaster)
      ? cases.adverse.broadcasts.length * (adverseMinutes + 1) : 0;
    const playMinutes = args.variant ? adverse : Math.max(b.relayInfo.playDrafts.length * (minutes + 1), adverse);
    await runBroadcaster(webUrl, b, playMinutes + Number(args['lead-minutes']),
      args.variant === 'restart' ? cases.restartEveryS : 0);
  } else {
    const browser = await chromium.launch({ channel: process.env.PLAYER_TEST_BROWSER ?? 'chrome', args: browserArgs });
    let results = [];
    if (args.mtt) results = await runMtt(browser, webUrl, cases);
    if (args['broadcast-player']) {
      const profile = args.profile ? cases.profiles[args.profile] : null;
      if (args.profile && !profile) throw new Error(`unknown profile ${args.profile}`);
      const specs = args['broadcast-player'].split(',');
      let impair = null;
      if (profile && (profile.netem || profile.down || profile.up || profile.events?.some((e) => e.blackoutS))) {
        impair = await Impairment.forRelays(specs.map((spec) => broadcastCase(cases, spec).relayInfo.url));
        await impair.setup();
        await impair.apply(profile);
        log(`profile ${args.profile}: shaping ${impair.addresses.join(', ')} on ${impair.dev}`);
      }
      for (const spec of specs) {
        const b = broadcastCase(cases, spec, profile?.variant);
        for (const draft of profile ? b.relayInfo.playDrafts.slice(0, 1) : b.relayInfo.playDrafts) {
          const prefix = profile ? `${args.profile}-` : '';
          results.push(await playCase(browser, webUrl, { name: `${prefix}g5-${b.packaging}-${b.relay}-d${draft}`,
            url: b.relayInfo.url, namespace: b.namespace, draft, packaging: b.packaging, expected: cases.broadcastExpected,
            waitS: Number(args['wait-s']), profile, profileName: args.profile }, impair));
        }
      }
    }
    await browser.close();
    await report(results);
    failed = results.length === 0 || results.some((r) => r.verdict !== 'played');
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  for (const c of children) { try { process.kill(-c.child.pid, 'SIGTERM'); } catch { c.child.kill('SIGTERM'); } }
}
process.exit(failed ? 1 : 0);
