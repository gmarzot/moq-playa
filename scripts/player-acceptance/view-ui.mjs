import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

/** Exercise the actual demo controls, not a second implementation of retuning. */
export async function checkExampleViews(page, webUrl, query, artifacts, name, canvasOutput) {
  await page.addInitScript(() => {
    const state = window.__viewEvidence = { transports: [], errors: [], taps: [] };
    const NativeTransport = WebTransport;
    window.WebTransport = class extends NativeTransport {
      constructor(...args) {
        super(...args);
        const record = { status: 'pending' };
        state.transports.push(record);
        this.closed.then(() => { record.status = 'closed'; }, error => {
          record.status = 'rejected'; record.reason = String(error);
        });
      }
    };
    const connect = AudioNode.prototype.connect;
    const contexts = new WeakMap();
    AudioNode.prototype.connect = function (...args) {
      const result = Reflect.apply(connect, this, args);
      if ((this instanceof GainNode || this instanceof AudioBufferSourceNode) && args[0] instanceof AudioDestinationNode) {
        let analyser = contexts.get(this.context);
        if (!analyser) {
          analyser = this.context.createAnalyser();
          analyser.fftSize = 4096;
          contexts.set(this.context, analyser);
          state.taps.push(analyser);
        }
        Reflect.apply(connect, this, [analyser]);
      }
      return result;
    };
    let current;
    Object.defineProperty(window, '__player', {
      get: () => current,
      set: player => {
        current = player;
        player?.on('error', e => { if (current === player) state.errors.push(e.error.message); });
      },
    });
  });
  query.set('v', '18');
  query.set('log', 'error');
  await page.goto(`${webUrl}player/?${query}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#start').click();
  if (!canvasOutput) {
    await page.evaluate(() => {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(document.querySelector('#video'));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      source.connect(analyser); analyser.connect(ctx.destination);
      window.__viewEvidence.taps.push(analyser);
      window.__viewEvidence.observerContext = ctx;
      return ctx.resume();
    });
  }
  const observations = [];
  for (const group of [1, 0, 1, 0]) {
    await page.hover('#player-wrap');
    if (observations.length) await selectView(page, group);
    await page.waitForFunction(({ group, canvasOutput }) => {
      const p = window.__player;
      const element = document.querySelector(canvasOutput ? '#canvas' : '#video');
      const width = canvasOutput ? element.width : element.videoWidth;
      return window.__liveness().isPlaying && p.currentView === group
        && width === (group === 0 ? 360 : 640) && p.stats.currentResolution?.width === width
        && (canvasOutput ? p.videoPresentation?.renderedAtUs != null : !element.paused && element.currentTime > 0.1);
    }, { group, canvasOutput }, { timeout: 20000 });
    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await page.evaluate(canvasOutput => {
        const el = document.querySelector(canvasOutput ? '#canvas' : '#video');
        const probe = document.createElement('canvas'); probe.width = 64; probe.height = 36;
        const ctx = probe.getContext('2d'); ctx.drawImage(el, 0, 0, 64, 36);
        let hash = 2166136261;
        for (const byte of ctx.getImageData(0, 0, 64, 36).data) hash = Math.imul(hash ^ byte, 16777619);
        const taps = window.__viewEvidence.taps;
        const analyser = taps.at(-1);
        const pcm = new Float32Array(analyser?.fftSize ?? 1);
        analyser?.getFloatTimeDomainData(pcm);
        return { hash, audioRms: Math.sqrt(pcm.reduce((s, v) => s + v * v, 0) / pcm.length),
          renderedAtUs: window.__player.videoPresentation?.renderedAtUs ?? null,
          mediaTime: el.currentTime ?? null,
          paused: el.paused ?? null, readyState: el.readyState ?? null,
          buffered: el.buffered ? Array.from({ length: el.buffered.length }, (_, i) => [el.buffered.start(i), el.buffered.end(i)]) : null,
          tracks: window.__player.availableVideoTracks.map(t => t.name),
          transports: window.__viewEvidence.transports.map(t => ({ ...t })) };
      }, canvasOutput));
      await page.waitForTimeout(250);
    }
    observations.push({ group, samples });
    await writeFile(join(artifacts, `${name}-samples.json`), JSON.stringify(observations, null, 2));
    assert.ok(new Set(samples.map(s => s.hash)).size >= 3, 'Retuned picture must keep moving');
    assert.ok(samples.some(s => s.audioRms > 0.015), 'Retuned audio must flow');
    assert.deepEqual(samples.at(-1).tracks, [group === 0 ? 'video-portrait' : 'video-360']);
    // A live view switch keeps the session: one transport, still open.
    assert.deepEqual(samples.at(-1).transports.map(t => t.status), ['pending'], 'A view switch must keep the session');
    await page.screenshot({ path: join(artifacts, `${name}-${observations.length}-${group}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.hover('#player-wrap');
  const mobileControl = await page.locator('#video-track-btn').boundingBox();
  assert.ok(mobileControl && mobileControl.x >= 0 && mobileControl.x + mobileControl.width <= 390,
    'View control must fit the mobile viewport');
  await page.screenshot({ path: join(artifacts, `${name}-mobile-playing.png`) });
  await page.setViewportSize({ width: 800, height: 600 });
  // Stop must settle cleanly while a view switch is still in flight.
  await selectView(page, 1);
  await page.locator('#pause').click();
  await page.waitForFunction(() => !window.__liveness().transitioning && window.__player === null);
  await page.waitForFunction(() => window.__viewEvidence.transports.every(t => t.status !== 'pending'));
  const cancelled = await page.evaluate(() => ({ ...window.__liveness(), transports: window.__viewEvidence.transports,
    errors: window.__viewEvidence.errors, videoSource: document.querySelector('#video').getAttribute('src') }));
  assert.equal(cancelled.isPlaying, false);
  assert.deepEqual(cancelled.errors, []);
  assert.ok(!cancelled.videoSource, 'Old MediaSource must detach');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, `${name}-mobile.png`) });
  await page.evaluate(() => window.__viewEvidence.observerContext?.close());
  return { observations, cancelled };
}

/** Pick a view from the video menu by its catalog label (the item's title). */
async function selectView(page, group) {
  await page.hover('#player-wrap');
  const label = await page.evaluate(g => window.__player.availableViews.find(v => v.altGroup === g)?.label, group);
  assert.ok(label, `View ${group} must be listed with its catalog label`);
  await page.locator('#video-track-btn').click();
  await page.locator(`#video-track-menu .track-dropdown-item[title="${label}"]`).click();
}
