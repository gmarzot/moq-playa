/**
 * Broadcast example — publish camera/screen to a MoQ relay.
 *
 * Captures via getUserMedia/getDisplayMedia, encodes via WebCodecs,
 * packages with LOC headers, and publishes via MoqtConnection.
 *
 * The viewer URL points to g5-player with matching relay + namespace.
 *
 * @see draft-ietf-moq-transport-16 §9.13 (PUBLISH)
 * @see draft-ietf-moq-transport-16 §10.4.2 (Subgroup streams)
 * @see draft-ietf-moq-loc-01 §2.3 (LOC header extensions)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @module
 */

import { MoqtConnection } from '@moqt/webtransport';
import { varint } from '@moqt/transport';
import { BroadcastSession } from './broadcast-session.js';
import type { BroadcastSessionConnection } from './broadcast-session.js';
import { BroadcastAttempt } from './broadcast-attempt.js';
import type { AttemptResources } from './broadcast-attempt.js';
import { buildCatalogPayload } from './catalog-publisher.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';
import type { MediaPublisher } from './media-publisher.js';
import { log } from '../shared/log.js';
import { certHash, draftVersion } from '../shared/cert.js';
import { resolveRelayEndpoint, discoveredRelayUrl } from '../shared/relay-endpoint.js';
import {
  WebCodecsVideoEncoder,
  WebCodecsAudioEncoder,
  MediaCapture,
  createWebTransport,
} from '../shared/browser/index.js';

// ─── URL params ──────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
/**
 * Our relay. Discovery probes the page's own host, which never finds this one,
 * so it is the default rather than a fallback. `?url=` and the settings dialog
 * still override, and discovery still runs when either names something else.
 */
const DEFAULT_RELAY = 'https://moqx-main.ci.openmoq.org:4433/moq-relay';
/**
 * Our demos run draft 18. The shared default is moqt-16, so without this the
 * d18 wire behaviour the demos exist to exercise never gets negotiated.
 * `?v=` still overrides.
 */
const broadcastDraft: 14 | 16 | 18 = draftVersion ?? 18;
const videoCodec = params.get('codec') ?? 'avc1.42001f'; // Baseline Level 3.1 (720p)
const videoBitrate = parseInt(params.get('bitrate') ?? '2000', 10) * 1000;
const keyframeInterval = parseInt(params.get('keyframe') ?? '60', 10);
/** Published in the catalog as the viewer's playout set point. Without it the
 *  player has no target and runs with no cushion policy or chase at all. */
const targetLatencyMs = parseInt(params.get('target') ?? '200', 10);
/** How often the catalog is re-published so late joiners can acquire one.
 *  0 publishes it only at subscribe time. */
const catalogIntervalMs = parseInt(params.get('catalogInterval') ?? '1000', 10);
/** `?debug=1`: per-second ingest snapshots and catalog re-emissions. */
const debug = params.get('debug') === '1';
/** Capture frame rate. One frame period is latency before encode starts:
 *  42ms at 24fps, 17ms at 60. */
const captureFps = parseInt(params.get('fps') ?? '60', 10);
/** `?audioDatagram=1`: audio as OBJECT_DATAGRAMs. draft-18 only. */
const audioDatagrams = params.get('audioDatagram') === '1';
/** `?bitrateMode=constant`: hold encoder output near the target instead of
 *  letting complex frames and keyframes burst. Unset uses the spec default. */
const bitrateMode: 'constant' | 'variable' | undefined =
  params.get('bitrateMode') === 'constant' ? 'constant'
    : params.get('bitrateMode') === 'variable' ? 'variable' : undefined;
/**
 * `?ns=` when given, otherwise one minted per TAB and held in sessionStorage.
 *
 * Per-tab rather than per-load: a reload (including a dev-server hot reload)
 * keeps the namespace, so viewer links already handed out stay valid, while a
 * new tab still mints a fresh one — which is what stops two broadcasters
 * claiming the same name and stops a relay holding state from a dead session
 * routing subscribers to it.
 */
const NAMESPACE_KEY = 'g5-broadcast.namespace';
function mintNamespace(): string {
  const fresh = (): string => `g5-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const held = sessionStorage.getItem(NAMESPACE_KEY);
    if (held) return held;
    const minted = fresh();
    sessionStorage.setItem(NAMESPACE_KEY, minted);
    return minted;
  } catch {
    // Private mode or blocked site data: a per-load namespace still works,
    // it just will not survive a reload.
    return fresh();
  }
}
const namespace = params.get('ns') ?? mintNamespace();

// ─── Settings modal ──────────────────────────────────────────────────

{
  const settingsBtn = document.getElementById('settings-btn')!;
  const backdrop = document.getElementById('settings-backdrop')!;
  const sUrl = document.getElementById('s-url') as HTMLInputElement;
  const sNs = document.getElementById('s-ns') as HTMLInputElement;
  const sHash = document.getElementById('s-hash') as HTMLInputElement;
  const sVersion = document.getElementById('s-version') as HTMLSelectElement;
  const sCodec = document.getElementById('s-codec') as HTMLSelectElement;
  const sBitrate = document.getElementById('s-bitrate') as HTMLInputElement;
  const sKeyframe = document.getElementById('s-keyframe') as HTMLInputElement;
  const sBitrateMode = document.getElementById('s-bitrate-mode') as HTMLSelectElement;
  const sFps = document.getElementById('s-fps') as HTMLInputElement;
  const sTarget = document.getElementById('s-target') as HTMLInputElement;
  const sCatalogInterval = document.getElementById('s-catalog-interval') as HTMLInputElement;
  const sDebug = document.getElementById('s-debug') as HTMLInputElement;
  const sAudioDatagram = document.getElementById('s-audio-datagram') as HTMLInputElement;
  const applyBtn = document.getElementById('settings-apply')!;
  const cancelBtn = document.getElementById('settings-cancel')!;

  // Modal-scoped lazy discovery: opening settings with no explicit ?url= and
  // no cached result starts its own discovery consumer, aborted on
  // close/Apply. Independent of the Go Live flow's consumer — neither can
  // block the other (Stop never waits on this, and vice versa).
  let modalDiscovery: AbortController | undefined;

  function abortModalDiscovery() {
    modalDiscovery?.abort(new Error('settings closed'));
    modalDiscovery = undefined;
  }

  function populateFields() {
    sUrl.value = params.get('url') ?? discoveredRelayUrl() ?? DEFAULT_RELAY;
    if (!sUrl.value && !modalDiscovery) {
      modalDiscovery = new AbortController();
      void resolveRelayEndpoint({ signal: modalDiscovery.signal }).then(
        (url) => { if (!sUrl.value) sUrl.value = url; },
        () => { /* aborted or failed — the field stays editable */ },
      );
    }
    sNs.value = namespace;
    sHash.value = params.get('hash') ?? '';
    sVersion.value = String(broadcastDraft);
    sCodec.value = videoCodec;
    sBitrate.value = String(videoBitrate / 1000);
    sKeyframe.value = String(keyframeInterval);
    sBitrateMode.value = bitrateMode ?? '';
    sFps.value = String(captureFps);
    sTarget.value = String(targetLatencyMs);
    sCatalogInterval.value = String(catalogIntervalMs);
    sDebug.checked = debug;
    sAudioDatagram.checked = audioDatagrams;
  }

  settingsBtn.addEventListener('click', () => { populateFields(); backdrop.classList.add('visible'); });
  cancelBtn.addEventListener('click', () => { abortModalDiscovery(); backdrop.classList.remove('visible'); });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { abortModalDiscovery(); backdrop.classList.remove('visible'); }
  });

  applyBtn.addEventListener('click', () => {
    abortModalDiscovery();
    const np = new URLSearchParams();
    const url = sUrl.value.trim();
    const ns = sNs.value.trim();
    if (url) np.set('url', url);
    if (ns) np.set('ns', ns);
    if (sHash.value.trim()) np.set('hash', sHash.value.trim());
    if (sVersion.value) np.set('v', sVersion.value);
    if (sCodec.value !== 'avc1.42001f') np.set('codec', sCodec.value);
    if (sBitrate.value !== '2000') np.set('bitrate', sBitrate.value);
    if (sKeyframe.value !== '60') np.set('keyframe', sKeyframe.value);
    if (sBitrateMode.value) np.set('bitrateMode', sBitrateMode.value);
    if (sFps.value && sFps.value !== '60') np.set('fps', sFps.value);
    if (sTarget.value && sTarget.value !== '200') np.set('target', sTarget.value);
    if (sCatalogInterval.value && sCatalogInterval.value !== '1000') np.set('catalogInterval', sCatalogInterval.value);
    if (sDebug.checked) np.set('debug', '1');
    if (sAudioDatagram.checked) np.set('audioDatagram', '1');
    const qs = np.toString();
    window.location.href = window.location.pathname + (qs ? '?' + qs : '');
  });
}

// ─── DOM ─────────────────────────────────────────────────────────────

const preview = document.getElementById('preview') as HTMLVideoElement;
const stateBadge = document.getElementById('state')!;
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
const shareBackdrop = document.getElementById('share-backdrop')!;
const shareUrlInput = document.getElementById('share-url') as HTMLInputElement;
const shareCopyBtn = document.getElementById('share-copy')!;
const shareCopied = document.getElementById('share-copied')!;
const shareOpenBtn = document.getElementById('share-open')!;
const shareCloseBtn = document.getElementById('share-close')!;
let currentViewerLink = '';
const liveBadge = document.getElementById('live-badge')!;
const diagGrid = document.getElementById('diag-grid')!;
const advGrid = document.getElementById('adv-grid')!;
const advPanel = document.getElementById('adv-panel') as HTMLDetailsElement;
const catMeta = document.getElementById('cat-meta')!;
const catTracks = document.getElementById('cat-tracks')!;
const catJson = document.getElementById('cat-json')!;
const catToggle = document.getElementById('cat-toggle') as HTMLButtonElement;
const catCopy = document.getElementById('cat-copy') as HTMLButtonElement;
const catRestore = document.getElementById('cat-restore') as HTMLButtonElement;
const logCopy = document.getElementById('log-copy') as HTMLButtonElement;
const layoutEl = document.getElementById('layout')!;
const startCameraBtn = document.getElementById('start-camera') as HTMLButtonElement;
const startScreenBtn = document.getElementById('start-screen') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;

// MoQ state. Everything a broadcast touches — capture, encoders, connection,
// media publisher, alias allocator, audio settings — is owned by the
// per-broadcast startup TRANSACTION (BroadcastAttempt) and its
// BroadcastSession. There are no mutable resource globals: stopping attempt
// A and starting attempt B lets A's late continuations clean up only A's
// own resources, never B's — and lifecycle callbacks are identity-guarded
// in the session, so a delayed old-session onClose/onSubscribe cannot stop
// or mutate a replacement.
let currentAttempt: BroadcastAttempt | null = null;

type BroadcastState = 'idle' | 'starting' | 'live' | 'error';
function setState(label: string, cls: BroadcastState): void {
  stateBadge.textContent = label;
  stateBadge.className = cls === 'idle' ? 'state-badge' : `state-badge ${cls}`;
}

// Publication state the 1 Hz strip reads. The publisher REFERENCE is held
// here, never its counters: a superseded attempt must not write into its
// replacement's UI, so resetBroadcastUi clears it.
let currentPublisher: MediaPublisher | null = null;
let currentConnection: MoqtConnection | null = null;
let currentDraft: number | null = null;
let captureRes = '—';
let liveSinceMs: number | null = null;
let catalogJsonText = '';

/** Copy to the clipboard, confirming in the button itself. */
function wireCopy(btn: HTMLButtonElement, text: () => string): void {
  btn.addEventListener('click', async () => {
    const was = btn.textContent;
    try {
      await navigator.clipboard.writeText(text());
      btn.textContent = 'copied';
    } catch {
      btn.textContent = 'failed';
    }
    setTimeout(() => { btn.textContent = was; }, 1200);
  });
}

// ─── Published catalog ───────────────────────────────────────────────

/** Render the catalog from the SAME builder the catalog track publishes, so
 *  the panel cannot drift from the bytes on the wire. */
function renderCatalogPanel(params: BroadcastCatalogParams): void {
  const bytes = buildCatalogPayload(params);
  const text = new TextDecoder().decode(bytes);
  catalogJsonText = text;
  let tracks: Array<Record<string, unknown>> = [];
  try {
    const doc = JSON.parse(text) as { tracks?: Array<Record<string, unknown>> };
    tracks = doc.tracks ?? [];
    catJson.textContent = JSON.stringify(doc, null, 2);
  } catch {
    catJson.textContent = text;
  }
  catMeta.textContent = `${tracks.length} track(s) · ${bytes.byteLength}B`;
  catTracks.replaceChildren(...tracks.map((t) => {
    const row = document.createElement('div');
    row.className = 'cat-track';
    // 24000/1001 arrives as 23.976043701171875; three places is the most that
    // distinguishes real rates.
    const fps = Number(Number(t['framerate']).toFixed(3));
    const detail = t['name'] === 'audio'
      ? `${t['codec']} · ${t['samplerate']}Hz · ${t['channelConfig']}ch · ${Math.round(Number(t['bitrate']) / 1000)}kbps`
      : `${t['codec']} · ${t['width']}×${t['height']} · ${fps}fps · ${Math.round(Number(t['bitrate']) / 1000)}kbps`;
    row.innerHTML = `<span class="nm">${String(t['name'])}</span>`
      + `<span class="pk">${String(t['packaging'])}</span>`
      + `<span class="sub" data-track="${String(t['name'])}">pending</span>`
      + `<span class="dt">${detail}</span>`;
    return row;
  }));
}

/** Per-track relay subscription state. NOT a viewer count — the relay
 *  subscribes once per track and fans out downstream on its own. */
function renderTrackStates(): void {
  const paused = new Set(currentPublisher?.pausedTracks ?? []);
  const retired = new Set(currentPublisher?.retiredTracks ?? []);
  for (const el of catTracks.querySelectorAll<HTMLElement>('.sub')) {
    const track = el.dataset['track'] ?? '';
    const live = liveSinceMs !== null;
    let cls = '', label = 'pending';
    if (retired.has(track)) { cls = 'retired'; label = 'retired'; }
    else if (paused.has(track)) { cls = 'paused'; label = 'paused'; }
    else if (live) { cls = 'on'; label = 'forwarding'; }
    el.className = `sub ${cls}`.trim();
    el.textContent = label;
  }
}

// ─── Metrics strip ───────────────────────────────────────────────────

function cell(label: string, value: string, cls = ''): string {
  return `<div class="cell">${label}<b${cls ? ` class="${cls}"` : ''}>${value}</b></div>`;
}
const u = (s: string): string => `<span class="u">${s}</span>`;

let lastSample = { t: 0, frames: 0, chunks: 0, vBytes: 0, aBytes: 0 };
let fpsEnc = 0, vKbps = 0, aKbps = 0;

function renderMetrics(): void {
  const p = currentPublisher;
  const now = performance.now();
  if (p) {
    const dt = (now - lastSample.t) / 1000;
    if (lastSample.t > 0 && dt >= 0.5) {
      fpsEnc = (p.frameCount - lastSample.frames) / dt;
      vKbps = ((p.videoByteCount - lastSample.vBytes) * 8) / dt / 1000;
      aKbps = ((p.audioByteCount - lastSample.aBytes) * 8) / dt / 1000;
    }
    if (lastSample.t === 0 || dt >= 0.5) {
      lastSample = {
        t: now, frames: p.frameCount, chunks: p.audioChunkCount,
        vBytes: p.videoByteCount, aBytes: p.audioByteCount,
      };
    }
  }
  const upS = liveSinceMs === null ? 0 : Math.floor((Date.now() - liveSinceMs) / 1000);
  const up = `${Math.floor(upS / 60)}:${String(upS % 60).padStart(2, '0')}`;
  const q = p?.queueLimits ?? { video: 0, audio: 0 };
  const qv = p?.videoQueueDepth ?? 0, qa = p?.audioQueueDepth ?? 0;
  const backlog = qv > q.video / 2 || qa > q.audio / 2;

  diagGrid.innerHTML = [
    cell('uptime', up, liveSinceMs === null ? 'idle' : ''),
    cell('fps enc', p ? fpsEnc.toFixed(0) : '—', p ? 'num' : 'idle'),
    cell('bitrate v/a', p ? `${vKbps.toFixed(0)}/${aKbps.toFixed(0)}${u('kbps')}` : '—', p ? 'num' : 'idle'),
    cell('objects v/a', p ? `${p.frameCount}/${p.audioChunkCount}` : '—', p ? '' : 'idle'),
    cell('keyframes', p ? String(p.keyframeCount) : '—', p ? '' : 'idle'),
    cell('queue v/a', p ? `${qv}/${qa}${u(`of ${q.video}/${q.audio}`)}` : '—', backlog ? 'fault' : p ? '' : 'idle'),
    cell('capture', captureRes, captureRes === '—' ? 'idle' : 'str'),
    cell('namespace', namespace, 'str'),
    cell('draft', currentDraft ? String(currentDraft) : '—', currentDraft ? 'str' : 'idle'),
  ].join('');
  renderTrackStates();
}

/** Transport counters, when the implementation reports them. */
async function renderTransport(): Promise<void> {
  if (!advPanel.open) return;
  const stats = currentConnection ? await currentConnection.getTransportStats() : null;
  if (!stats || Object.keys(stats).length === 0) {
    advGrid.innerHTML = cell('transport', 'not reported by this transport', 'idle');
    return;
  }
  const pick = (k: string): string => (stats[k] !== undefined ? String(Math.round(stats[k]!)) : '—');
  advGrid.innerHTML = [
    cell('rtt', `${pick('smoothedRtt')}${u('ms')}`, 'num'),
    cell('min rtt', `${pick('minRtt')}${u('ms')}`),
    cell('bytes sent', pick('bytesSent')),
    cell('est send rate', `${pick('estimatedSendRate')}${u('bps')}`),
    cell('packets lost', pick('packetsLost'), Number(stats['packetsLost'] ?? 0) > 0 ? 'fault' : ''),
  ].join('');
}

setInterval(() => {
  renderMetrics();
  void renderTransport();
  logSnapshot();
}, 1000);
renderMetrics();

/** `?debug=1`: one line per second while publishing, so an overnight soak
 *  leaves a copyable time series rather than only a final reading. */
function logSnapshot(): void {
  if (!debug) return;
  const p = currentPublisher;
  if (!p || liveSinceMs === null) return;
  const q = p.queueLimits;
  log(`[ingest] fps=${fpsEnc.toFixed(0)} v=${vKbps.toFixed(0)}kbps a=${aKbps.toFixed(0)}kbps `
    + `obj=${p.frameCount}/${p.audioChunkCount} kf=${p.keyframeCount} `
    + `queue=${p.videoQueueDepth}/${p.audioQueueDepth} of ${q.video}/${q.audio}`
    + (p.pausedTracks.length ? ` paused=[${p.pausedTracks.join(',')}]` : '')
    + (p.retiredTracks.length ? ` retired=[${p.retiredTracks.join(',')}]` : ''));
}

// The namespace is minted per load, so the log is the only durable record of
// which one a soak ran on. Echo the whole configuration before anything starts.
log(`Namespace: ${namespace}`);
log(`Relay: ${params.get('url') ?? `${DEFAULT_RELAY} (default)`}`);
log(`Draft: ${broadcastDraft} · codec ${videoCodec} · ${videoBitrate / 1000}kbps · `
  + `keyframe every ${keyframeInterval} · target ${targetLatencyMs}ms`);

// ─── Catalog panel controls ──────────────────────────────────────────

const setCatalogHidden = (hidden: boolean): void => {
  layoutEl.classList.toggle('cat-hidden', hidden);
  catRestore.hidden = !hidden;
};
catToggle.addEventListener('click', () => setCatalogHidden(true));
catRestore.addEventListener('click', () => setCatalogHidden(false));
wireCopy(catCopy, () => catalogJsonText);
wireCopy(logCopy, () => document.getElementById('log')?.textContent ?? '');

// ─── Share modal ─────────────────────────────────────────────────────

shareBtn.addEventListener('click', () => {
  shareUrlInput.value = currentViewerLink;
  shareCopied.hidden = true;
  shareBackdrop.classList.add('visible');
  shareUrlInput.select();
});

shareCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentViewerLink).then(() => {
    shareCopied.hidden = false;
    setTimeout(() => { shareCopied.hidden = true; }, 2000);
  });
});

shareOpenBtn.addEventListener('click', () => window.open(currentViewerLink, '_blank'));
shareCloseBtn.addEventListener('click', () => shareBackdrop.classList.remove('visible'));
shareBackdrop.addEventListener('click', (e) => {
  if (e.target === shareBackdrop) shareBackdrop.classList.remove('visible');
});

// ─── Start ───────────────────────────────────────────────────────────

startCameraBtn.addEventListener('click', () => startBroadcast('camera'));
startScreenBtn.addEventListener('click', () => startBroadcast('screen'));
stopBtn.addEventListener('click', stopBroadcast);

async function startBroadcast(source: 'camera' | 'screen'): Promise<void> {
  startCameraBtn.disabled = true;
  startScreenBtn.disabled = true;
  stopBtn.disabled = false;
  setState('connecting', 'starting');

  // Attempt-local state threaded between steps (never module globals).
  let capture: MediaCapture | null = null;
  let videoEncoder: WebCodecsVideoEncoder | null = null;
  let audioEncoder: WebCodecsAudioEncoder | null = null;
  let connection: MoqtConnection | null = null;
  let resolvedRelayUrl = '';   // set by openSession; feeds the viewer link
  let negotiatedDraft: 14 | 16 | 18 = broadcastDraft;  // replaced by the agreed value at connect
  let audio: { sampleRate: number; channels: number } | undefined;
  let width = 1280;
  let height = 720;
  let fps = 30;

  const attempt: BroadcastAttempt = new BroadcastAttempt({
    // 1. Start capture — audio settings are ATTEMPT-LOCAL, derived from the
    // actual tracks (a screen capture without audio yields none).
    startCapture: async (ctx: AttemptResources) => {
      // Adopted BEFORE the start resolves: a rejected getUserMedia (or a
      // cancellation mid-prompt) must still stop the handle.
      const cap = ctx.adopt(new MediaCapture(), (c) => { c.stop(); });
      // Capture retires SYNCHRONOUSLY when Stop is pressed — camera/mic tracks
      // are released immediately, not after the session's bounded shutdown.
      ctx.onCancel(() => { try { cap.stop(); } catch { /* not started */ } });
      capture = cap;
      const stream = source === 'camera'
        ? await cap.startCamera({
          width: 1280, height: 720,
          // ideal only: a min is mandatory and hides devices that cannot meet it.
          frameRate: { ideal: captureFps },
        })
        : await cap.startScreen({ video: true, audio: false });
      // The tracks only become real HERE — MediaCapture.stop() before this
      // point cannot stop a stream it does not yet hold. Re-adopt the ACQUIRED
      // capture so a permission prompt that resolved AFTER Stop still has its
      // camera released (the adoption disposes immediately when cancelled).
      ctx.adopt(cap, (c) => { c.stop(); });
      ctx.throwIfCancelled();
      preview.srcObject = stream;
      log(`Capture started: ${source}`);

      const settings = cap.videoSettings;
      width = settings?.width ?? 1280;
      height = settings?.height ?? 720;
      fps = settings?.frameRate ?? 30;
      log(`Video: ${width}x${height} @ ${fps}fps`);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const audioSettings = audioTrack.getSettings();
        audio = {
          sampleRate: audioSettings.sampleRate ?? 48000,
          channels: audioSettings.channelCount ?? 1,
        };
      } else {
        log('Audio: no audio track in this capture');
      }
      return { stop: () => cap.stop() };
    },

    // 2. Configure encoders
    createEncoders: (ctx: AttemptResources) => {
      // Each encoder is adopted at construction, so a throw while configuring
      // the SECOND one still destroys the first.
      const ve = ctx.adopt(new WebCodecsVideoEncoder(), (e) => { e.destroy(); });
      // Encoders also retire synchronously at Stop: no further frames are
      // encoded while the session drains.
      ctx.onCancel(() => { try { ve.destroy(); } catch { /* already destroyed */ } });
      videoEncoder = ve;
      ve.configure(videoCodec, width, height, {
        bitrate: videoBitrate,
        framerate: fps,
        keyframeInterval,
        latencyMode: 'realtime',
        ...(bitrateMode ? { bitrateMode } : {}),
      });
      log(`Video encoder: ${videoCodec} @ ${videoBitrate / 1000}kbps`
        + ` · ${bitrateMode ?? 'variable'} bitrate`);
      if (audio) {
        const ae = ctx.adopt(new WebCodecsAudioEncoder(), (e) => { e.destroy(); });
        ctx.onCancel(() => { try { ae.destroy(); } catch { /* already destroyed */ } });
        audioEncoder = ae;
        ae.configure('opus', audio.sampleRate, audio.channels, { bitrate: 128_000 });
        log(`Audio encoder: opus @ 128kbps (${audio.sampleRate}Hz, ${audio.channels}ch)`);
      }
      // Disposal is handled per-encoder by the adoptions above.
      return { destroy: () => { /* owned by the attempt registry */ } };
    },

    // 3. Transport + connection + session, wired. The session's wire
    // behavior binds to the NEGOTIATED draft (connection.draftVersion after
    // connect), not the configured preference.
    openSession: async (ctx: AttemptResources) => {
      // The settings dialog writes its value back to ?url=, so the param covers
      // both ways of naming a relay; absent either, use ours.
      const relayUrl = params.get('url') ?? DEFAULT_RELAY;
      ctx.throwIfCancelled();
      resolvedRelayUrl = relayUrl;

      log(`Connecting to ${relayUrl}...`);
      const transportFactory = createWebTransport({ ...(certHash ? { certHash } : {}), draftVersion: broadcastDraft });
      // Each resource is adopted the moment it exists — a cancellation or a
      // handshake failure between these awaits must not leak the transport or
      // the connection.
      const transport = ctx.adopt(await transportFactory(relayUrl), (t) => {
        try { (t as unknown as { close(): void }).close(); } catch { /* already closed */ }
      });
      ctx.throwIfCancelled();
      const conn = ctx.adopt(new MoqtConnection(broadcastDraft), (c) => c.close());
      connection = conn;

      conn.onError = (err) => { log(`Session error: ${err.message}`); };
      conn.onMessage = (msg) => {
        log(`[CTRL] ${msg.type}${('requestId' in msg) ? ` reqId=${(msg as any).requestId}` : ''}`);
      };

      // Cancellation must REACH the in-progress handshake: closing the
      // transport makes a pending connect() settle instead of hanging.
      ctx.onCancel(() => {
        try { (transport as unknown as { close(): void }).close(); } catch { /* already closed */ }
      });
      await conn.connect(transport, { maxRequestId: varint(100) });
      ctx.throwIfCancelled();
      negotiatedDraft = conn.draftVersion;
      currentDraft = negotiatedDraft;
      currentConnection = conn;
      log(`Session established (draft-${negotiatedDraft}).`);

      const session = ctx.adopt(new BroadcastSession(conn as unknown as BroadcastSessionConnection, {
        catalog: {
          videoCodec,
          width,
          height,
          fps,
          videoBitrate,
          targetLatencyMs,
          ...(audio ? { audio } : {}),
        },
        publisher: {
          wrapInt: (n) => varint(n),
          draft: negotiatedDraft,
          audioDatagrams,
          onError: (context, err) => log(`Failed ${context}: ${(err as Error)?.message ?? err}`),
        },
        log,
        catalogIntervalMs,
        ...(debug ? { onCatalogReemitted: (bytes: number) => log(`Catalog re-emitted (${bytes} bytes)`) } : {}),
        onCatalogPublished: () => {
          setState('live', 'live');
          liveBadge.hidden = false;
          liveSinceMs ??= Date.now();
        },
        // Only the CURRENT attempt's session may drive the global stop.
        onSessionClosed: () => { if (currentAttempt === attempt) void stopBroadcast(); },
      }), (sess) => sess.shutdown());

      // No await between connect resolution and these assignments — nothing
      // can be missed. Handlers reference only this attempt's session.
      conn.onClose = (error, reason) => {
        log(`Session closed: error=${error ?? 'none'} reason=${reason ?? 'clean'}`);
        transport.closed.then((info: any) => {
          log(`WebTransport closed: code=${info?.closeCode ?? 'N/A'} reason=${info?.reason ?? 'N/A'}`);
        }).catch(() => {});
        session.handleClose(error, reason);
      };
      conn.onSubscribe = (requestId, _ns, trackName) => {
        session.handleSubscribe(requestId, new TextDecoder().decode(trackName));
      };
      return session;
    },

    // 4. Announce namespace
    publishNamespace: async (ctx: AttemptResources) => {
      const enc = new TextEncoder();
      const nsBytes = namespace.split('/').map(p => enc.encode(p));
      log(`Sending PUBLISH_NAMESPACE for [${namespace}]...`);
      await connection!.publishNamespace(nsBytes);
      ctx.throwIfCancelled();
      log(`PUBLISH_NAMESPACE sent, waiting for relay response...`);
    },

    // 5. Wire encoder output → MoQ publish. WebCodecs chunk callbacks are
    // synchronous and void — publication is a synchronous ENQUEUE into this
    // generation's serialized publisher, which builds the LOC extensions
    // under the negotiated draft's wire profile.
    wirePublication: (session) => {
      const mediaPublisher = session.publisher;
      currentPublisher = mediaPublisher;
      const ve = videoEncoder!;
      ve.onChunk = (data, isKeyframe, timestamp, _duration, description) => {
        const videoConfig = description ?? ve.description;
        mediaPublisher.publishVideo(data, {
          isKeyframe,
          timestampUs: timestamp,
          ...(videoConfig ? { videoConfig } : {}),
        });
      };
      ve.onError = (err) => log(`[VideoEncoder ERROR] ${err.message}`);
      capture!.onError = (err) => log(`[Capture ERROR] ${err.message}`);
      if (audioEncoder) {
        const ae = audioEncoder;
        ae.onChunk = (data, timestamp) => {
          mediaPublisher.publishAudio(data, { timestampUs: timestamp });
        };
        ae.onError = (err) => log(`[AudioEncoder ERROR] ${err.message}`);
      }

      // 6. Wire capture → encoder
      capture!.onVideoFrame = (frame) => {
        ve.encode(frame);
        frame.close();
      };
      capture!.onAudioData = (data) => {
        audioEncoder?.encode(data);
        data.close();
      };

      // Carry the resolved endpoint and certificate hash into the viewer link.
      const viewerBase = window.location.origin + '/g5-player/';
      const viewerParams = new URLSearchParams();
      viewerParams.set('url', resolvedRelayUrl);
      viewerParams.set('ns', namespace);
      // The catalog is served only from the SUBSCRIBE handler — there is no
      // FETCH responder here, so the player's default SUBSCRIBE + Joining
      // FETCH path has no fallback it will accept.
      viewerParams.set('catalogBootstrap', 'subscribe');
      // A verbose broadcaster hands out a verbose viewer.
      if (debug) viewerParams.set('debug', '1');
      viewerParams.set('v', String(negotiatedDraft));
      const hashParam = params.get('hash');
      if (hashParam) viewerParams.set('hash', hashParam);
      currentViewerLink = `${viewerBase}?${viewerParams.toString()}`;
      shareBtn.hidden = false;
      captureRes = `${width}x${height}`;
      renderCatalogPanel({
        videoCodec, width, height, fps, videoBitrate, targetLatencyMs,
        ...(audio ? { audio } : {}),
      });
      setState('awaiting subscribe', 'starting');
    },
  });

  currentAttempt = attempt;
  try {
    const result = await attempt.run();
    if (result === 'cancelled') return; // superseded — the UI belongs to the replacement
  } catch (err) {
    // Only the CURRENT attempt's failure is the user's failure; a stale
    // attempt has already been quiet-cancelled inside run().
    log(`Fatal: ${(err as Error).message}`);
    console.error(err);
    if (currentAttempt === attempt) {
      currentAttempt = null;
      resetBroadcastUi();
    }
  }
}

// ─── Stop ────────────────────────────────────────────────────────────

async function stopBroadcast(): Promise<void> {
  // Cancel the pending/current attempt SYNCHRONOUSLY (its continuations go
  // inert at their next gate), then await its teardown: capture, encoders,
  // and a graceful bounded session shutdown.
  const attempt = currentAttempt;
  currentAttempt = null;
  await attempt?.cancel();
  // If a new broadcast started while we awaited, the UI belongs to it.
  if (currentAttempt === null) resetBroadcastUi();
  log('Broadcast stopped.');
}

function resetBroadcastUi(): void {
  preview.srcObject = null;
  setState('idle', 'idle');
  liveBadge.hidden = true;
  shareBtn.hidden = true;
  currentPublisher = null;
  currentConnection = null;
  currentDraft = null;
  captureRes = '—';
  liveSinceMs = null;
  lastSample = { t: 0, frames: 0, chunks: 0, vBytes: 0, aBytes: 0 };
  startCameraBtn.disabled = false;
  startScreenBtn.disabled = false;
  stopBtn.disabled = true;
}
