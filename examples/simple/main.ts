/**
 * Playa — Simple Example
 *
 * The entire player wired to a full UI in ~30 lines of player code.
 * Everything else is DOM glue.
 */

import { Player } from '@playa/player';
import { namespace, certHash, draftVersion } from '../shared/cert.js';
import { resolveRelayEndpoint, onDiscoveryAttempt } from '../shared/relay-endpoint.js';

// ─── DOM refs & helpers ─────────────────────────────────────────────

const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const seekBar = document.getElementById('seek') as HTMLInputElement;
const timeDisplay = document.getElementById('time')!;
const volumeBar = document.getElementById('volume') as HTMLInputElement;
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const qualitySelect = document.getElementById('quality') as HTMLSelectElement;
const stateBadge = document.getElementById('state')!;
const diagGrid = document.getElementById('diag-grid')!;
const latSpark = document.getElementById('lat-spark') as HTMLCanvasElement;
const jitSpark = document.getElementById('jit-spark') as HTMLCanvasElement;
const latVal = document.getElementById('lat-val')!;
const jitVal = document.getElementById('jit-val')!;
const logEl = document.getElementById('log')!;
const playerContainer = document.getElementById('player-container')!;

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Main ───────────────────────────────────────────────────────────
// Explicit ?url= is used as-is; otherwise the shared discovery probes the
// page host's common endpoint paths. Total failure renders the diagnostic
// and stops — no rethrow, no unhandled page error.

async function main(): Promise<void> {
  log('Discovering relay endpoint...');
  onDiscoveryAttempt((url, outcome) => log(`  probe ${url}: ${outcome}`));
  let relayUrl: string;
  try {
    relayUrl = await resolveRelayEndpoint();
  } catch (err) {
    log(`Fatal: ${(err as Error).message}`);
    stateBadge.textContent = 'error';
    stateBadge.className = 'state-badge error';
    return;
  }

  // ── Create Player ─────────────────────────────────────────────────

  const player = new Player(playerContainer, {
    url: relayUrl,
    namespace,
    ...(certHash ? { certHash } : {}),
    ...(draftVersion ? { draftVersion } : {})
  });

  // ── Wire Events ───────────────────────────────────────────────────

  player.on('statechange', ({ state }) => {
    stateBadge.textContent = state;
    stateBadge.className = `state-badge ${state}`;
  });

  player.on('ready', ({ levels }) => {
    log(`Ready: ${levels.length} quality level(s)`);
    playBtn.disabled = false;
    muteBtn.disabled = false;
    qualitySelect.disabled = false;
    qualitySelect.innerHTML = '<option value="auto">Auto</option>';
    for (const level of levels) {
      const opt = document.createElement('option');
      opt.value = String(level.index);
      opt.textContent = `${level.label} (${Math.round(level.bitrate / 1000)}k)`;
      qualitySelect.appendChild(opt);
    }
  });

  player.on('playing', () => log('First frame rendered'));

  player.on('timeupdate', ({ currentTime }) => {
    timeDisplay.textContent = formatTime(currentTime);
    if (player.duration) {
      seekBar.max = String(player.duration);
      seekBar.value = String(currentTime);
      seekBar.disabled = !player.seekable;
    }
  });

  player.on('durationchange', ({ duration }) => log(`Duration: ${formatTime(duration)}`));
  player.on('qualitychange', ({ level, auto }) => log(`Quality: ${level.label} (${auto ? 'ABR' : 'manual'})`));
  player.on('stall', ({ durationMs }) => log(`Stall: ${durationMs}ms`));
  player.on('error', ({ severity, message }) => log(`[${severity}] ${message}`));

  player.on('stats', (s: any) => {
    const cell = (label: string, v: string) =>
      `<div class="cell">${label}<b>${v}</b></div>`;
    const res = s.resolution ?? s.currentResolution;
    diagGrid.innerHTML = [
      cell('state', player.state),
      cell('ttff ms', s.timeToFirstFrameMs != null ? s.timeToFirstFrameMs.toFixed(0) : '—'),
      cell('resolution', res ? `${res.width}x${res.height}` : '—'),
      cell('codec', s.videoCodec ?? s.currentVideoCodec ?? '—'),
      cell('rendered', String(s.framesRendered ?? 0)),
      cell('decoded', String(s.framesDecoded ?? 0)),
      cell('dropped', String(s.framesDropped ?? 0)),
      cell('buf v/a s', `${(s.videoBufferDepth ?? 0).toFixed(2)}/${(s.audioBufferDepth ?? 0).toFixed(2)}`),
      cell('dec queue', String(s.videoDecoderQueueDepth ?? 0)),
      cell('objects', String(s.objectsReceived ?? 0)),
      cell('mb rx', ((s.bytesReceived ?? 0) / 1e6).toFixed(1)),
      cell('gaps', String(s.gapsReceived ?? s.gapCount ?? 0)),
      cell('stalls', `${s.stallCount ?? 0} (${((s.totalStallDurationMs ?? 0) / 1000).toFixed(1)}s)`),
      cell('a/v skew ms', s.avSkewEwmaMs != null ? s.avSkewEwmaMs.toFixed(0) : '—'),
    ].join('');
  });

  // ── Latency & jitter sparklines (from media_object arrivals) ─────

  const latSamples: number[] = [];
  const jitSamples: number[] = [];
  let lastArrivalMs = 0;
  let expectedIntervalMs = 0;
  const pushSample = (a: number[], v: number) => {
    a.push(v);
    if (a.length > 180) a.shift();
  };

  player.on('media_object', (e: any) => {
    if (e.mediaType !== 'video' || e.kind !== 'data') return;
    const now = performance.now();
    if (lastArrivalMs) {
      const interval = now - lastArrivalMs;
      if (expectedIntervalMs) pushSample(jitSamples, Math.abs(interval - expectedIntervalMs));
      expectedIntervalMs = expectedIntervalMs
        ? expectedIntervalMs * 0.9 + interval * 0.1 : interval;
    }
    lastArrivalMs = now;
    if (e.captureTimestamp && e.captureTimestamp > 0n) {
      const latencyMs = Date.now() - Number(e.captureTimestamp) / 1000;
      if (latencyMs > -1000 && latencyMs < 30_000) pushSample(latSamples, latencyMs);
    }
  });

  function drawSpark(canvas: HTMLCanvasElement, data: number[],
                     valEl: HTMLElement, color: string): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    if (data.length < 2) return;
    const max = Math.max(...data) * 1.15 || 1;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (v / max) * (h - 6) - 3;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = devicePixelRatio;
    ctx.stroke();
    valEl.textContent = data[data.length - 1].toFixed(0);
  }

  setInterval(() => {
    drawSpark(latSpark, latSamples, latVal, '#4d4');
    drawSpark(jitSpark, jitSamples, jitVal, '#da4');
  }, 250);

  // ── Controls ──────────────────────────────────────────────────────

  playBtn.addEventListener('click', () => {
    if (player.state === 'playing') player.pause();
    else player.play();
  });

  player.on('play', () => { playBtn.textContent = 'Pause'; });
  player.on('pause', () => { playBtn.textContent = 'Play'; });

  seekBar.addEventListener('input', () => player.seek(Number(seekBar.value)));
  volumeBar.addEventListener('input', () => player.setVolume(Number(volumeBar.value) / 100));
  muteBtn.addEventListener('click', () => player.toggleMute());
  player.on('volumechange', ({ muted }) => { muteBtn.textContent = muted ? 'Unmute' : 'Mute'; });

  qualitySelect.addEventListener('change', () => {
    const val = qualitySelect.value;
    void player.setQuality(val === 'auto' ? 'auto' : Number(val))
      .catch((err: unknown) => log(`Quality switch failed: ${(err as Error).message}`));
  });

  // ── Load ──────────────────────────────────────────────────────────

  log(`Relay: ${relayUrl}`);
  log(`Namespace: ${namespace}`);
  player.load().catch((err) => log(`Fatal: ${(err as Error).message}`));
}

void main();
