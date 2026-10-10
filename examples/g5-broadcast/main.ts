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

import { MoqtConnection } from '@openmoq/webtransport';
import { varint } from '@openmoq/transport';
import { BroadcastSession } from './broadcast-session.js';
import type { BroadcastSessionConnection, CarriedCatalog, TrackStatus } from './broadcast-session.js';
import { BroadcastAttempt } from './broadcast-attempt.js';
import type { AttemptResources } from './broadcast-attempt.js';
import { buildCatalogPayload } from './catalog-publisher.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';
import type { MediaPublisher } from './media-publisher.js';
import { CMAF_AUDIO_TRACK_ID, CMAF_VIDEO_TRACK_ID } from './media-publisher.js';
import { buildAudioInit, buildVideoInit, MICROSECOND_TIMESCALE } from '../shared/browser/cmaf-mux.js';
import { log } from '../shared/log.js';
import { parseCertHashHex } from '../shared/relay-url.js';
import { parseCompat } from '../shared/compat.js';
import { resolveRelayEndpoint, discoveredRelayUrl } from '../shared/relay-endpoint.js';
import { copyOnClick } from '../shared/copyable.js';
import { setBadge } from '../shared/status-badge.js';
import type { BadgeTone } from '../shared/status-badge.js';
import {
  WebCodecsVideoEncoder,
  WebCodecsAudioEncoder,
  MediaCapture,
  createWebTransport,
} from '../shared/browser/index.js';

// ─── Settings ────────────────────────────────────────────────────────

/** Storage that is blocked or absent (private mode, site data off) reads as empty. */
function storageGet(store: () => Storage, key: string): string | null {
  try { return store().getItem(key); } catch { return null; }
}
/** False when the storage refused the write. */
function storageSet(store: () => Storage, key: string, value: string | null): boolean {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Settings saved by the dialog, as URL parameters: per tab in sessionStorage
 * (kept across its reloads), and in localStorage as the start for new tabs.
 */
const SETTINGS_KEY = 'g5-broadcast.settings';
/** Saved settings, each overridden by a URL parameter of the same name. */
const params = (() => {
  const saved = storageGet(() => sessionStorage, SETTINGS_KEY) ?? storageGet(() => localStorage, SETTINGS_KEY);
  const merged = new URLSearchParams(saved ?? '');
  const url = new URLSearchParams(window.location.search);
  for (const name of new Set(url.keys())) {
    merged.delete(name);
    for (const value of url.getAll(name)) merged.append(name, value);
  }
  return merged;
})();
/**
 * Our relay. Discovery probes the page's own host, which never finds this one,
 * so it is the default rather than a fallback.
 */
const DEFAULT_RELAY = 'https://moqx-main.ci.openmoq.org:4433/moq-relay';
/** Our demos run draft 18; the shared default is draft 16. */
const DEFAULT_DRAFT = 18;
const broadcastDraft: 14 | 16 | 18 = (() => {
  const v = params.get('v');
  return v === '14' ? 14 : v === '16' ? 16 : DEFAULT_DRAFT;
})();
const certHash: ArrayBuffer | undefined = (() => {
  const hex = params.get('hash');
  if (!hex) return undefined;
  try {
    return parseCertHashHex(hex);
  } catch (err) {
    log(`Ignoring certificate hash: ${(err as Error).message}`);
    return undefined;
  }
})();
/** `?compat=`: opt-in interop for a non-conformant relay (shared/compat.ts). URL only. */
const compatParam = parseCompat(params.get('compat'));
const videoCodec = params.get('codec') ?? 'avc1.42001f'; // Baseline Level 3.1 (720p)
const videoBitrate = parseInt(params.get('bitrate') ?? '2000', 10) * 1000;
const keyframeInterval = parseInt(params.get('keyframe') ?? '60', 10);
/** Published in the catalog as the viewer's playout set point. Without it the
 *  player has no target and runs with no cushion policy or chase at all. */
const targetLatencyMs = parseInt(params.get('target') ?? '200', 10);
/** Catalog re-publication period; null takes the draft's default
 *  ({@link catalogIntervalFor}). 0 publishes it only at subscribe time. */
const catalogIntervalParam = params.get('catalogInterval');
const catalogIntervalMs = catalogIntervalParam === null ? null : parseInt(catalogIntervalParam, 10);
/** Draft-18 viewers FETCH the latest catalog; draft-14/16 viewers, which
 *  this page cannot serve by FETCH, need it re-published. */
const catalogIntervalFor = (draft: 14 | 16 | 18): number => catalogIntervalMs ?? (draft === 18 ? 0 : 1000);
/** `?debug=1`: per-second ingest snapshots and catalog re-emissions. */
const debug = params.get('debug') === '1';
/** `?status=0` hides the state overlay, which is on by default on this page. */
const showStatus = params.get('status') !== '0';
/** Capture frame rate. One frame period is latency before encode starts:
 *  42ms at 24fps, 17ms at 60. */
const captureFps = parseInt(params.get('fps') ?? '60', 10);
/** `?audioDatagram=1`: audio as OBJECT_DATAGRAMs. draft-18 only. */
const audioDatagrams = params.get('audioDatagram') === '1';
/** Audio actually on datagrams: asked for, draft-18, and not LOCMAF (subgroups only). */
let audioOnDatagrams = false;
/** `?packaging=cmaf|locmaf`: objects as CMAF chunks (CMSF-01) or LOCMAF Objects instead of LOC. */
const packagingParam = params.get('packaging');
const packaging: 'loc' | 'cmaf' | 'locmaf' =
  packagingParam === 'cmaf' || packagingParam === 'locmaf' ? packagingParam : 'loc';
/** `?bitrateMode=constant`: hold encoder output near the target instead of
 *  letting complex frames and keyframes burst. Unset uses the spec default. */
const bitrateMode: 'constant' | 'variable' | undefined =
  params.get('bitrateMode') === 'constant' ? 'constant'
    : params.get('bitrateMode') === 'variable' ? 'variable' : undefined;
/** `?congestionControl=low-latency|throughput`: a hint to the browser's QUIC
 *  congestion controller. Unset leaves the browser default. */
const congestionControl: 'low-latency' | 'throughput' | undefined =
  params.get('congestionControl') === 'low-latency' ? 'low-latency'
    : params.get('congestionControl') === 'throughput' ? 'throughput' : undefined;
/**
 * The tab's automatic namespace, held in sessionStorage. Each broadcast after
 * the first under it mints another, so a relay never answers a new catalog
 * from an earlier broadcast's cache; reconnects within a broadcast keep it.
 * A new tab, or New in the settings dialog, also mints one.
 */
const AUTO_NAMESPACE_KEY = 'g5-broadcast.namespace';
/** The automatic namespace a broadcast has already used. */
const AUTO_NAMESPACE_USED_KEY = 'g5-broadcast.namespace-used';
const mintNamespace = (): string => `g5-${crypto.randomUUID().slice(0, 8)}`;
function tabNamespace(): string {
  const held = storageGet(() => sessionStorage, AUTO_NAMESPACE_KEY);
  if (held) return held;
  const minted = mintNamespace();
  storageSet(() => sessionStorage, AUTO_NAMESPACE_KEY, minted);
  return minted;
}
/** A named namespace (URL or saved), else the tab's automatic one. */
const namedNamespace = params.get('ns') || null;
let namespace = namedNamespace ?? tabNamespace();
let usedNamespace = storageGet(() => sessionStorage, AUTO_NAMESPACE_USED_KEY);

/** The namespace for a new broadcast: an automatic one already broadcast under is replaced. */
function claimNamespace(): void {
  if (namedNamespace === null && usedNamespace === namespace) {
    namespace = mintNamespace();
    storageSet(() => sessionStorage, AUTO_NAMESPACE_KEY, namespace);
    setText('conn-ns', namespace);
    log(`Namespace: ${namespace} (new broadcast)`);
  }
  usedNamespace = namespace;
  storageSet(() => sessionStorage, AUTO_NAMESPACE_USED_KEY, namespace);
}

/**
 * The last catalog this browser published: its namespace, group and bytes. A
 * later broadcast under that namespace with the same catalog keeps the group,
 * so a relay's cached copy stays the current catalog.
 */
const LAST_CATALOG_KEY = 'g5-broadcast.last-catalog';
function loadLastCatalog(ns: string): CarriedCatalog | null {
  try {
    const saved = JSON.parse(storageGet(() => localStorage, LAST_CATALOG_KEY) ?? 'null');
    if (saved?.namespace !== ns) return null;
    return { group: BigInt(saved.group), payload: Uint8Array.from(atob(saved.payload), (c) => c.charCodeAt(0)) };
  } catch {
    return null;
  }
}
function saveLastCatalog(ns: string, catalog: CarriedCatalog): void {
  storageSet(() => localStorage, LAST_CATALOG_KEY, JSON.stringify({
    namespace: ns,
    group: catalog.group.toString(),
    payload: btoa(String.fromCharCode(...catalog.payload)),
  }));
}

// ─── Settings modal ──────────────────────────────────────────────────

{
  const settingsBtn = document.getElementById('settings-btn')!;
  const backdrop = document.getElementById('settings-backdrop')!;
  const sUrl = document.getElementById('s-url') as HTMLInputElement;
  const sNs = document.getElementById('s-ns') as HTMLInputElement;
  const sNsNew = document.getElementById('s-ns-new') as HTMLButtonElement;
  const sHash = document.getElementById('s-hash') as HTMLInputElement;
  const sVersion = document.getElementById('s-version') as HTMLSelectElement;
  const sCc = document.getElementById('s-cc') as HTMLSelectElement;
  const sCodec = document.getElementById('s-codec') as HTMLSelectElement;
  const sBitrate = document.getElementById('s-bitrate') as HTMLInputElement;
  const sKeyframe = document.getElementById('s-keyframe') as HTMLInputElement;
  const sBitrateMode = document.getElementById('s-bitrate-mode') as HTMLSelectElement;
  const sFps = document.getElementById('s-fps') as HTMLInputElement;
  const sTarget = document.getElementById('s-target') as HTMLInputElement;
  const sCatalogInterval = document.getElementById('s-catalog-interval') as HTMLInputElement;
  const sStatus = document.getElementById('s-status') as HTMLInputElement;
  const sDebug = document.getElementById('s-debug') as HTMLInputElement;
  const sAudioDatagram = document.getElementById('s-audio-datagram') as HTMLInputElement;
  const sPackaging = document.getElementById('s-packaging') as HTMLSelectElement;
  const applyBtn = document.getElementById('settings-apply')!;
  const cancelBtn = document.getElementById('settings-cancel')!;

  // Modal-scoped lazy discovery: opening settings with no relay URL set and
  // no cached result starts its own discovery consumer, aborted on
  // close/Apply. Independent of the Go Live flow's consumer — neither can
  // block the other (Stop never waits on this, and vice versa).
  let modalDiscovery: AbortController | undefined;
  /** The automatic namespace the field holds, if any; Apply keeps it unnamed. */
  let autoNamespace: string | null = null;

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
    autoNamespace = namedNamespace === null ? namespace : null;
    sHash.value = params.get('hash') ?? '';
    sVersion.value = String(broadcastDraft);
    sCc.value = congestionControl ?? '';
    sCodec.value = videoCodec;
    sBitrate.value = String(videoBitrate / 1000);
    sKeyframe.value = String(keyframeInterval);
    sBitrateMode.value = bitrateMode ?? '';
    sFps.value = String(captureFps);
    sTarget.value = String(targetLatencyMs);
    sCatalogInterval.value = catalogIntervalMs === null ? '' : String(catalogIntervalMs);
    showCatalogIntervalDefault();
    sStatus.checked = showStatus;
    sDebug.checked = debug;
    sAudioDatagram.checked = audioDatagrams;
    sPackaging.value = packaging;
  }

  /** The blank interval's value: the selected draft's default. */
  function showCatalogIntervalDefault() {
    sCatalogInterval.placeholder = String(catalogIntervalFor(Number(sVersion.value) as 14 | 16 | 18));
  }
  sVersion.addEventListener('change', showCatalogIntervalDefault);

  settingsBtn.addEventListener('click', () => { populateFields(); backdrop.classList.add('visible'); });
  sNsNew.addEventListener('click', () => {
    autoNamespace = mintNamespace();
    sNs.value = autoNamespace;
  });
  cancelBtn.addEventListener('click', () => { abortModalDiscovery(); backdrop.classList.remove('visible'); });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { abortModalDiscovery(); backdrop.classList.remove('visible'); }
  });
  // Enter in a field applies, as a form submit would; buttons and the
  // Advanced toggle keep their own Enter.
  backdrop.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT') return;
    e.preventDefault();
    applyBtn.click();
  });

  applyBtn.addEventListener('click', () => {
    abortModalDiscovery();
    const np = new URLSearchParams();
    const url = sUrl.value.trim();
    const ns = sNs.value.trim();
    if (url && url !== DEFAULT_RELAY) np.set('url', url);
    if (ns && ns === autoNamespace) storageSet(() => sessionStorage, AUTO_NAMESPACE_KEY, ns);
    else if (ns) np.set('ns', ns);
    if (sHash.value.trim()) np.set('hash', sHash.value.trim());
    if (sVersion.value && sVersion.value !== String(DEFAULT_DRAFT)) np.set('v', sVersion.value);
    if (sCc.value) np.set('congestionControl', sCc.value);
    if (sCodec.value !== 'avc1.42001f') np.set('codec', sCodec.value);
    if (sBitrate.value !== '2000') np.set('bitrate', sBitrate.value);
    if (sKeyframe.value !== '60') np.set('keyframe', sKeyframe.value);
    if (sBitrateMode.value) np.set('bitrateMode', sBitrateMode.value);
    if (sFps.value && sFps.value !== '60') np.set('fps', sFps.value);
    if (sTarget.value && sTarget.value !== '200') np.set('target', sTarget.value);
    if (sCatalogInterval.value) np.set('catalogInterval', sCatalogInterval.value);
    if (!sStatus.checked) np.set('status', '0');
    if (sDebug.checked) np.set('debug', '1');
    if (sAudioDatagram.checked) np.set('audioDatagram', '1');
    if (sPackaging.value !== 'loc') np.set('packaging', sPackaging.value);
    // The dialog showed URL overrides too, so they are saved and the URL drops
    // them; where storage is refused, the URL carries them instead. `compat`
    // is URL-only and stays.
    const qs = np.toString();
    // An empty string, not removal: this tab chose the defaults.
    const saved = storageSet(() => sessionStorage, SETTINGS_KEY, qs);
    storageSet(() => localStorage, SETTINGS_KEY, qs || null);
    const next = new URLSearchParams(saved ? '' : qs);
    const compat = new URLSearchParams(window.location.search).get('compat');
    if (compat) next.set('compat', compat);
    const query = next.toString();
    window.location.assign(window.location.pathname + (query ? '?' + query : ''));
  });
}

// ─── DOM ─────────────────────────────────────────────────────────────

const preview = document.getElementById('preview') as HTMLVideoElement;
const stateBadge = document.getElementById('state')!;
stateBadge.hidden = !showStatus;
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
const shareBackdrop = document.getElementById('share-backdrop')!;
const shareUrlInput = document.getElementById('share-url') as HTMLInputElement;
const shareCopyBtn = document.getElementById('share-copy')!;
const shareCopied = document.getElementById('share-copied')!;
const shareOpenBtn = document.getElementById('share-open')!;
const shareCloseBtn = document.getElementById('share-close')!;
let currentViewerLink = '';
const diagGrid = document.getElementById('diag-grid')!;
const advGrid = document.getElementById('adv-grid')!;
const advPanel = document.getElementById('adv-panel') as HTMLDetailsElement;
const catMeta = document.getElementById('cat-meta')!;
const catSize = document.getElementById('cat-size')!;
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
let currentTransport: { close(): void } | null = null;
let currentSession: BroadcastSession | null = null;
/** The PUBLISH_NAMESPACE awaiting or holding the relay's reply, and its badge. */
let nsRequestId: string | null = null;
let nsBadgeState: { tone: BadgeTone; detail: string } = { tone: 'idle', detail: 'PUBLISH_NAMESPACE not sent' };
/** The MoQT session itself: SETUP, established, or closed. */
let setupBadgeState: { tone: BadgeTone; detail: string } = { tone: 'idle', detail: 'No session' };
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

/** Audio, then video, then anything else in the order it arrived. */
const trackRank = (name: unknown): number =>
  name === 'audio' ? 0 : name === 'video' ? 1 : 2;

/** CMSF when any track is CMAF or LOCMAF, else MSF, with the catalog's version. */
const catalogLabel = (packagings: unknown[], version: unknown): string => {
  const format = packagings.some((p) => p === 'cmaf' || p === 'locmaf') ? 'CMSF' : 'MSF';
  const v = String(version ?? '?');
  return `${format} ${v.startsWith('draft-') ? v : `v${v}`}`;
};

/** Render the catalog from the SAME builder the catalog track publishes, so
 *  the panel cannot drift from the bytes on the wire. */
function renderCatalogPanel(params: BroadcastCatalogParams): void {
  const bytes = buildCatalogPayload(params);
  const text = new TextDecoder().decode(bytes);
  catalogJsonText = text;
  let tracks: Array<Record<string, unknown>> = [];
  let version: unknown;
  try {
    const doc = JSON.parse(text) as
      { tracks?: Array<Record<string, unknown>>; version?: unknown };
    tracks = doc.tracks ?? [];
    version = doc.version;
    catJson.textContent = JSON.stringify(doc, null, 2);
  } catch {
    catJson.textContent = text;
  }
  // Same header as the player's catalog panel.
  catMeta.textContent = catalogLabel(tracks.map((t) => t['packaging']), version);
  catSize.textContent = ` · ${bytes.byteLength}B`;
  // Display order only; the published catalog keeps its own.
  const ordered = [...tracks].sort(
    (a, b) => trackRank(a['name']) - trackRank(b['name']));
  catTracks.replaceChildren(...ordered.map((t) => {
    const row = document.createElement('div');
    const role = t['name'] === 'video' ? ' video' : t['name'] === 'audio' ? ' audio' : '';
    row.className = `cat-track${role}`;
    // 24000/1001 arrives as 23.976043701171875; three places is the most that
    // distinguishes real rates.
    const fps = Number(Number(t['framerate']).toFixed(3));
    const detail = t['name'] === 'audio'
      ? `${t['codec']} · ${t['samplerate']}Hz · ${t['channelConfig']}ch · ${Math.round(Number(t['bitrate']) / 1000)}kbps`
        + (audioOnDatagrams ? ' · datagrams' : '')
      : `${t['codec']} · ${t['width']}×${t['height']} · ${fps}fps · ${Math.round(Number(t['bitrate']) / 1000)}kbps`;
    row.innerHTML = `<span class="nm">${String(t['name'])}:</span>`
      + `<span class="dt">${detail}</span>`
      + `<span class="badge idle" data-track="${String(t['name'])}">FWD --</span>`;
    return row;
  }));
}

const nsBadge = document.getElementById('ns-badge')!;
const setupBadge = document.getElementById('setup-badge')!;
const catBadge = document.getElementById('cat-badge')!;

/** A track's subscription as the relay drives it. NOT a viewer count: the
 *  relay subscribes once per track and fans out downstream on its own. */
function trackBadge(el: HTMLElement, status: TrackStatus | null): void {
  if (status === null || status.state === 'none') {
    setBadge(el, 'FWD --', 'idle', status?.ended ? `No subscription · ${status.ended}` : 'No subscription');
    return;
  }
  const sub = `SUBSCRIBE reqId=${status.requestId} · alias=${status.alias}`;
  if (status.fault) setBadge(el, 'ERR', 'bad', `${sub} · accepted, but the track is not being produced`);
  else if (status.forward) setBadge(el, 'FWD 1', 'ok', `${sub} · Forward State 1`);
  else setBadge(el, 'FWD 0', 'wait', `${sub} · Forward State 0: the relay paused forwarding`);
}

function renderStatusBadges(): void {
  setBadge(setupBadge, 'SETUP', setupBadgeState.tone, setupBadgeState.detail);
  setBadge(nsBadge, 'PUB_NS', nsBadgeState.tone, nsBadgeState.detail);
  trackBadge(catBadge, currentSession?.trackStatus('catalog') ?? null);
  for (const el of catTracks.querySelectorAll<HTMLElement>('.badge[data-track]')) {
    const track = el.dataset['track'];
    if (track === 'video' || track === 'audio') trackBadge(el, currentSession?.trackStatus(track) ?? null);
  }
}

// ─── Metrics strip ───────────────────────────────────────────────────

/** Metrics-row hover text. */
const CELL_TIPS: Record<string, string> = {
  'bitrate a/v': 'Sent kbps, audio/video.',
  'fps enc': 'Video frames encoded per second.',
  'target': 'Target latency in the catalog.',
  'objects a/v': 'Objects sent, audio/video.',
  'keyframes': 'Keyframes sent, one per group.',
  'queue a/v': 'Chunks waiting to send, audio/video. Small: queue limit.',
  'uptime': 'Time since going live.',
};

function cell(label: string, value: string, cls = ''): string {
  const tip = CELL_TIPS[label];
  return `<div class="cell"${tip ? ` title="${tip}"` : ''}>${label}<b${cls ? ` class="${cls}"` : ''}>${value}</b></div>`;
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

  // Measurements only; relay, namespace and draft are on the title line.
  diagGrid.innerHTML = [
    cell('bitrate a/v', p ? `${aKbps.toFixed(0)}/${vKbps.toFixed(0)}${u('kbps')}` : '—', p ? 'num' : 'idle'),
    cell('fps enc', p ? fpsEnc.toFixed(0) : '—', p ? 'num' : 'idle'),
    // A setting published in the catalog, so it reads the same live or idle.
    cell('target', `${targetLatencyMs}${u('ms')}`, 'num'),
    cell('objects a/v', p ? `${p.audioChunkCount}/${p.frameCount}` : '—', p ? 'num' : 'idle'),
    cell('keyframes', p ? String(p.keyframeCount) : '—', p ? 'num' : 'idle'),
    // Frames waiting for the wire, against the depth where shedding starts.
    cell('queue a/v', p ? `${qa}/${qv}${u(`max ${q.audio}/${q.video}`)}` : '—',
      backlog ? 'fault' : p ? 'num' : 'idle'),
    cell('uptime', up, liveSinceMs === null ? 'idle' : 'num'),
  ].join('');
  renderStatusBadges();
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

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

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
    + (p.endedTracks.length ? ` ended=[${p.endedTracks.join(',')}]` : ''));
}

// The log is the durable record of what a soak ran with: echo the whole
// configuration before anything starts.
log(`Namespace: ${namespace}${namedNamespace === null ? ' (this tab)' : ''}`);
log(`Settings: ${params.toString() || 'defaults'}`);
if (compatParam.unknown.length) log(`Ignoring unknown compat: ${compatParam.unknown.join(', ')}`);
log(`Relay: ${params.get('url') ?? `${DEFAULT_RELAY} (default)`}`);
setText('conn-relay', params.get('url') ?? DEFAULT_RELAY);
setText('conn-ns', namespace);
for (const id of ['conn-relay', 'conn-ns']) {
  const el = document.getElementById(id);
  if (el) copyOnClick(el);
}
setText('conn-draft', String(broadcastDraft));
log(`Draft: ${broadcastDraft} · codec ${videoCodec} · ${videoBitrate / 1000}kbps · `
  + `keyframe every ${keyframeInterval} · target ${targetLatencyMs}ms`);

// ─── Catalog panel controls ──────────────────────────────────────────

const setCatalogHidden = (hidden: boolean): void => {
  layoutEl.classList.toggle('cat-hidden', hidden);
  catRestore.hidden = !hidden;
  catToggle.hidden = hidden;
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

shareOpenBtn.addEventListener('click', (e) => {
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    // A separate window at this window's size, opened on the next task: inside
    // the click, Chrome applies the held modifier instead (Ctrl = background
    // tab). A popup carries less chrome than a tabbed window, so the outer size
    // is matched after opening.
    const features = `popup,width=${window.innerWidth},height=${window.innerHeight}`;
    setTimeout(() => {
      const win = window.open(currentViewerLink, '_blank', features);
      win?.resizeTo(window.outerWidth, window.outerHeight);
    }, 0);
  } else {
    window.open(currentViewerLink, '_blank');
  }
  shareBackdrop.classList.remove('visible');
});
shareCloseBtn.addEventListener('click', () => shareBackdrop.classList.remove('visible'));
shareBackdrop.addEventListener('click', (e) => {
  if (e.target === shareBackdrop) shareBackdrop.classList.remove('visible');
});

// ─── Start ───────────────────────────────────────────────────────────

startCameraBtn.addEventListener('click', () => startBroadcast('camera'));
startScreenBtn.addEventListener('click', () => startBroadcast('screen'));
stopBtn.addEventListener('click', stopBroadcast);

/** Longest Stop waits for the namespace withdrawal before closing the session. */
const NS_WITHDRAW_MS = 500;

// A page closing or reloading mid-broadcast cannot await the shutdown: start the
// withdrawal and close the session now, so a reload reusing ?ns= finds no stale
// registration at the relay.
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return;
  if (currentConnection && nsRequestId !== null) {
    void currentConnection.publishNamespaceDone(BigInt(nsRequestId)).catch(() => {});
  }
  try { currentTransport?.close(); } catch { /* already closed */ }
});

/** Backoff between reconnects after the session closes under a broadcast:
 *  the first is immediate, later ones back off until a session stays up. */
const RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000];
/** Attempts before giving up: about ten minutes at the longest delay. */
const RECONNECT_MAX_ATTEMPTS = 40;
/** A session up this long resets the backoff. */
const RECONNECT_STABLE_MS = 30_000;

async function startBroadcast(source: 'camera' | 'screen'): Promise<void> {
  claimNamespace();
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
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectCount = 0;
  let sessionUpSinceMs: number | null = null;
  /** The catalog the current session serves; CMAF attaches its init segments later. */
  let sessionCatalog: BroadcastCatalogParams | null = null;
  /** The catalog group last published under this namespace; kept when the catalog is unchanged. */
  let carriedCatalog: CarriedCatalog | null = loadLastCatalog(namespace);
  /** The video encoder's decoder description, from its first keyframe: CMAF's video init needs it. */
  let videoDescription: Uint8Array | null = null;
  const descriptionWaiters = new Set<(description: Uint8Array) => void>();
  const noteVideoDescription = (description: Uint8Array): void => {
    if (videoDescription) return;
    videoDescription = description;
    for (const wake of descriptionWaiters) wake(description);
    descriptionWaiters.clear();
  };
  /** Bounds the wait for the first keyframe; encoding starts right after the namespace is announced. */
  const CMAF_INIT_WAIT_MS = 5_000;
  const videoDescriptionReady = (): Promise<Uint8Array> => {
    if (videoDescription) return Promise.resolve(videoDescription);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        descriptionWaiters.delete(wake);
        reject(new Error(`no keyframe from the video encoder within ${CMAF_INIT_WAIT_MS / 1000}s`));
      }, CMAF_INIT_WAIT_MS);
      const wake = (description: Uint8Array): void => { clearTimeout(timer); resolve(description); };
      descriptionWaiters.add(wake);
    });
  };
  /** CMAF: build both init segments once the video description exists. */
  const attachCmafInit = async (catalog: BroadcastCatalogParams): Promise<void> => {
    if (catalog.cmaf) return;
    const description = await videoDescriptionReady();
    catalog.cmaf = {
      videoInit: buildVideoInit({
        trackId: CMAF_VIDEO_TRACK_ID, timescale: MICROSECOND_TIMESCALE, codec: catalog.videoCodec,
        width: catalog.width, height: catalog.height, description,
      }),
      ...(catalog.audio ? {
        audioInit: buildAudioInit({
          trackId: CMAF_AUDIO_TRACK_ID, timescale: MICROSECOND_TIMESCALE,
          sampleRate: catalog.audio.sampleRate, channels: catalog.audio.channels,
        }),
      } : {}),
    };
    if (catalog === sessionCatalog) renderCatalogPanel(catalog);
  };

  // The publisher's drift report measures each chunk as it is sent, after
  // encoding. This twin takes the same lowest wall − stamp gap as frames come
  // off the camera and microphone, plus each encoder's peak queue, so a stamp
  // that loses time can be told from a pipeline that falls behind.
  const captureAnchorUs = new Map<'video' | 'audio', number>();
  const captureMinUs = new Map<'video' | 'audio', number>();
  const encoderQueuePeak = { video: 0, audio: 0 };
  // Camera frames about two frames apart or more, or whose stamp does not
  // advance, are logged; at most one line a second.
  let lastVideoCaptureUs: number | null = null;
  let videoFrameUs: number | null = null;
  let videoGapLoggedMs = 0;
  let videoGapsUnlogged = 0;
  const noteVideoCaptureGap = (timestampUs: number): void => {
    const prev = lastVideoCaptureUs;
    lastVideoCaptureUs = timestampUs;
    if (prev === null) return;
    const deltaUs = timestampUs - prev;
    const frameUs = videoFrameUs;
    // Typical spacing, learned from ordinary intervals only.
    if (deltaUs > 0 && (frameUs === null || deltaUs < 1.5 * frameUs)) {
      videoFrameUs = frameUs === null ? deltaUs : frameUs + (deltaUs - frameUs) / 32;
    }
    if (frameUs === null || (deltaUs > 0 && deltaUs < 1.8 * frameUs)) return;
    const nowMs = performance.now();
    if (nowMs - videoGapLoggedMs < 1000) {
      videoGapsUnlogged++;
      return;
    }
    log(`Capture ${deltaUs > 0 ? 'gap' : 'stamp did not advance'}: video frames ${(deltaUs / 1000).toFixed(1)}ms apart`
      + ` (typical ${(frameUs / 1000).toFixed(1)}ms)`
      + (videoGapsUnlogged > 0 ? ` · ${videoGapsUnlogged} more since the last line` : ''));
    videoGapLoggedMs = nowMs;
    videoGapsUnlogged = 0;
  };
  const noteCapture = (track: 'video' | 'audio', timestampUs: number, queueDepth: number): void => {
    if (track === 'video') noteVideoCaptureGap(timestampUs);
    const gapUs = Date.now() * 1000 - timestampUs;
    if (!captureAnchorUs.has(track)) captureAnchorUs.set(track, gapUs);
    const min = captureMinUs.get(track);
    if (min === undefined || gapUs < min) captureMinUs.set(track, gapUs);
    if (queueDepth > encoderQueuePeak[track]) encoderQueuePeak[track] = queueDepth;
  };
  const driftMs = (us: number) => `${us >= 0 ? '+' : ''}${(us / 1000).toFixed(1)}ms`;
  const describeDrift = (videoUs: number | null, audioUs: number | null): string => [
    ...(videoUs !== null ? [`video ${driftMs(videoUs)}`] : []),
    ...(audioUs !== null ? [`audio ${driftMs(audioUs)}`] : []),
    ...(videoUs !== null && audioUs !== null ? [`video−audio ${driftMs(videoUs - audioUs)}`] : []),
  ].join(', ');
  const describeLocmafHeaders = ({ full, delta }: { full: number; delta: number }): string =>
    `full/delta ${full}/${delta}`;
  /** This period's capture-side drift and encoder peaks; starts the next period. */
  const takeCaptureDrift = (): string => {
    const at = (t: 'video' | 'audio'): number | null => {
      const min = captureMinUs.get(t);
      const anchor = captureAnchorUs.get(t);
      return min === undefined || anchor === undefined ? null : min - anchor;
    };
    const line = `captured ${describeDrift(at('video'), at('audio'))}`
      + ` · encoder queue peak video ${encoderQueuePeak.video}, audio ${encoderQueuePeak.audio}`;
    captureMinUs.clear();
    encoderQueuePeak.video = 0;
    encoderQueuePeak.audio = 0;
    return line;
  };

  // The session closed under the broadcast: rebuild only the network side,
  // with backoff, while capture and encoders keep running.
  function scheduleReconnect(): void {
    if (currentAttempt !== attempt || reconnectTimer !== null) return;
    if (sessionUpSinceMs !== null && Date.now() - sessionUpSinceMs >= RECONNECT_STABLE_MS) {
      reconnectCount = 0;
    }
    sessionUpSinceMs = null;
    if (reconnectCount >= RECONNECT_MAX_ATTEMPTS) {
      setupBadgeState = { tone: 'bad', detail: `Session closed; reconnect gave up after ${reconnectCount} attempts` };
      log(`Reconnect gave up after ${reconnectCount} attempts.`);
      void stopBroadcast();
      return;
    }
    reconnectCount++;
    nsRequestId = null;
    nsBadgeState = { tone: 'wait', detail: `Session lost; reconnect attempt ${reconnectCount}` };
    setupBadgeState = { tone: 'wait', detail: `Session closed; reconnect attempt ${reconnectCount}` };
    const delayMs = RECONNECT_DELAYS_MS[Math.min(reconnectCount, RECONNECT_DELAYS_MS.length) - 1]!;
    setState('reconnecting', 'starting');
    log(delayMs > 0
      ? `Reconnecting (attempt ${reconnectCount} in ${delayMs / 1000}s)`
      : `Reconnecting (attempt ${reconnectCount})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (currentAttempt !== attempt) return;
      attempt.reopen().then((result) => {
        if (result !== 'completed' || currentAttempt !== attempt) return;
        sessionUpSinceMs = Date.now();
        log('Session re-established.');
      }, (err: unknown) => {
        log(`Reconnect failed: ${(err as Error)?.message ?? err}`);
        scheduleReconnect();
      });
    }, delayMs);
  }

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
      ctx.onCancel(() => { if (reconnectTimer !== null) clearTimeout(reconnectTimer); });
      capture = cap;
      const stream = source === 'camera'
        ? await cap.startCamera({
          width: 1280, height: 720,
          // ideal only: a min is mandatory and hides devices that cannot meet it.
          frameRate: { ideal: captureFps },
        })
        : await cap.startScreen({ video: { frameRate: { ideal: captureFps } }, audio: false });
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
      videoDescription = null;
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
      const relayUrl = params.get('url') ?? DEFAULT_RELAY;
      ctx.throwIfCancelled();
      resolvedRelayUrl = relayUrl;

      log(`Connecting to ${relayUrl}...`);
      const transportFactory = createWebTransport({
        ...(certHash ? { certHash } : {}),
        draftVersion: broadcastDraft,
        ...(congestionControl ? { congestionControl } : {}),
      });
      // Each resource is adopted the moment it exists — a cancellation or a
      // handshake failure between these awaits must not leak the transport or
      // the connection.
      const transport = ctx.adopt(await transportFactory(relayUrl), (t) => {
        try { (t as unknown as { close(): void }).close(); } catch { /* already closed */ }
      });
      currentTransport = transport as unknown as { close(): void };
      ctx.throwIfCancelled();
      const conn = ctx.adopt(new MoqtConnection(broadcastDraft), (c) => c.close());
      connection = conn;

      conn.onError = (err) => {
        // A cancelled attempt's failures are its own teardown.
        if (ctx.cancelled) return;
        // A non-fatal note leaves the session up; its message carries its context.
        const fatal = (err as { isFatal?: boolean }).isFatal !== false;
        log(fatal ? `Session error: ${err.message}` : err.message);
      };
      conn.onMessage = (msg) => {
        log(`[CTRL] ${msg.type}${('requestId' in msg) ? ` reqId=${(msg as any).requestId}` : ''}`);
        // The relay's reply to our PUBLISH_NAMESPACE.
        const rid = (msg as { requestId?: unknown }).requestId;
        if (rid === undefined || nsRequestId === null || String(rid) !== nsRequestId) return;
        if (msg.type === 'REQUEST_OK' || msg.type === 'PUBLISH_NAMESPACE_OK') {
          nsBadgeState = { tone: 'ok', detail: `PUBLISH_NAMESPACE reqId=${nsRequestId} · ${msg.type}` };
        } else if (msg.type === 'REQUEST_ERROR' || msg.type === 'PUBLISH_NAMESPACE_ERROR') {
          const why = (msg as { errorReason?: string; reasonPhrase?: string }).errorReason
            ?? (msg as { reasonPhrase?: string }).reasonPhrase ?? '';
          nsBadgeState = { tone: 'bad', detail: `PUBLISH_NAMESPACE reqId=${nsRequestId} · ${msg.type} ${why}`.trim() };
        }
      };

      // Cancellation must REACH the in-progress handshake: closing the
      // transport makes a pending connect() settle instead of hanging.
      ctx.onCancel(() => {
        try { (transport as unknown as { close(): void }).close(); } catch { /* already closed */ }
      });
      setupBadgeState = { tone: 'wait', detail: `SETUP sent to ${resolvedRelayUrl || relayUrl}; awaiting the relay` };
      await conn.connect(transport, {
        maxRequestId: varint(100),
        ...(compatParam.compat.includes('request-credit') ? { requestsUncappedUntilMaxRequestId: true } : {}),
      });
      ctx.throwIfCancelled();
      if (conn.session?.uncappedRequestCredit.active) {
        log('Relay granted no request credit (SERVER_SETUP without MAX_REQUEST_ID); '
          + 'requests go uncapped until it sends one (compat request-credit)');
      }
      negotiatedDraft = conn.draftVersion;
      setupBadgeState = { tone: 'ok', detail: `Session established, draft-${conn.draftVersion}` };
      // Show the negotiated draft.
      setText('conn-draft', String(negotiatedDraft));
      currentConnection = conn;
      log(`Session established (draft-${negotiatedDraft}).`);
      audioOnDatagrams = audioDatagrams && negotiatedDraft === 18 && packaging !== 'locmaf';
      if (packaging === 'locmaf' && audioDatagrams) log('LOCMAF: audio stays on subgroups (no datagrams)');
      log(`Congestion control: requested ${congestionControl ?? 'browser default'}, `
        + `browser applied ${transport.congestionControl ?? 'not reported'}`);

      const catalog: BroadcastCatalogParams = {
        videoCodec,
        width,
        height,
        fps,
        videoBitrate,
        targetLatencyMs,
        packaging,
        ...(audio ? { audio } : {}),
      };
      sessionCatalog = catalog;
      const session = ctx.adopt(new BroadcastSession(conn as unknown as BroadcastSessionConnection, {
        catalog,
        ...(packaging !== 'loc' ? { catalogReady: () => attachCmafInit(catalog) } : {}),
        ...(carriedCatalog ? { carriedCatalog } : {}),
        onCatalogGroup: (published) => {
          carriedCatalog = published;
          saveLastCatalog(namespace, published);
        },
        publisher: {
          wrapInt: (n) => varint(n),
          draft: negotiatedDraft,
          audioDatagrams,
          packaging,
          cmafInit: () => catalog.cmaf,
          // The anchor's measured error, once per track.
          onAnchor: ({ track, excessUs, timeOriginDeltaUs }) => log(
            `Capture anchor ${track}: first chunk cost `
            + `${(excessUs / 1000).toFixed(1)}ms vs the best seen`
            + (timeOriginDeltaUs === undefined ? ''
              : `, ${(timeOriginDeltaUs / 1000).toFixed(1)}ms from timeOrigin`)),
          // Each track's capture clock against the wall clock, per minute.
          onDrift: ({ elapsedMs, videoUs, audioUs, followUs }) => {
            log(`Capture drift at ${(elapsedMs / 60_000).toFixed(1)} min: `
              + `sent ${describeDrift(videoUs, audioUs)} · ${takeCaptureDrift()}`
              + (followUs !== null ? ` · wall-clock follow ${driftMs(followUs)}` : '')
              + (packaging === 'locmaf' ? ` · LOCMAF headers ${describeLocmafHeaders(session.publisher.locmafHeaders)}` : ''));
          },
          onError: (context, err) => log(`Failed ${context}: ${(err as Error)?.message ?? err}`),
          onStatus: (track, message) => log(`${track}: ${message}`),
          onKeyframeNeeded: () => videoEncoder?.requestKeyframe(),
        },
        log,
        catalogIntervalMs: catalogIntervalFor(negotiatedDraft),
        ...(debug ? { onCatalogReemitted: (bytes: number) => log(`Catalog re-emitted (${bytes} bytes)`) } : {}),
        onCatalogPublished: () => {
          setState('live', 'live');
          liveSinceMs ??= Date.now();
        },
        // Only the CURRENT attempt's session may drive a reconnect.
        onSessionClosed: () => { if (currentAttempt === attempt) scheduleReconnect(); },
      }), (sess) => sess.shutdown());

      // No await between connect resolution and these assignments — nothing
      // can be missed. Handlers reference only this attempt's session.
      conn.onClose = (error, reason) => {
        log(`Session closed: error=${error ?? 'none'} reason=${reason ?? 'clean'}`);
        setupBadgeState = { tone: 'bad', detail: `Session closed: error=${error ?? 'none'} ${reason ?? ''}`.trim() };
        transport.closed.then((info: any) => {
          log(`WebTransport closed: code=${info?.closeCode ?? 'N/A'} reason=${info?.reason ?? 'N/A'}`);
        }).catch(() => {});
        session.handleClose(error, reason);
      };
      conn.onSubscribe = (requestId, _ns, trackName) => {
        session.handleSubscribe(requestId, new TextDecoder().decode(trackName));
      };
      conn.onSubscribeClosed = (requestId) => session.handleSubscribeClosed(requestId);
      conn.onFetch = (requestId, fetch) => session.handleFetch(requestId, fetch);
      conn.onSubscribeForwardStateChange = (requestId, forward) =>
        session.handleForwardChange(requestId, forward);
      // A draft-18 resume must carry the Largest Location (§5.1).
      conn.setLargestLocationProvider((requestId) => session.largestLocation(requestId));
      return session;
    },

    // 4. Announce namespace
    publishNamespace: async (ctx: AttemptResources, session: BroadcastSession) => {
      const enc = new TextEncoder();
      const nsBytes = namespace.split('/').map(p => enc.encode(p));
      log(`Sending PUBLISH_NAMESPACE for [${namespace}]...`);
      const nsConn = connection!;
      const nsRid = await nsConn.publishNamespace(nsBytes);
      // Disposed before the session (LIFO): Stop and reconnect end each
      // subscription with PUBLISH_DONE, then withdraw the namespace, so the
      // relay drops its state through the protocol instead of holding it for a
      // timeout. Bounded: a dead session must not stall Stop.
      ctx.adopt(nsRid, async (rid) => {
        await session.endSubscriptions();
        await Promise.race([
          nsConn.publishNamespaceDone(rid).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, NS_WITHDRAW_MS)),
        ]);
      });
      nsRequestId = String(nsRid);
      nsBadgeState = { tone: 'wait', detail: `PUBLISH_NAMESPACE reqId=${nsRid} sent; awaiting the relay's reply` };
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
      currentSession = session;
      const ve = videoEncoder!;
      ve.onChunk = (data, isKeyframe, timestamp, duration, description) => {
        const videoConfig = description ?? ve.description;
        if (videoConfig) noteVideoDescription(videoConfig);
        mediaPublisher.publishVideo(data, {
          isKeyframe,
          timestampUs: timestamp,
          ...(videoConfig ? { videoConfig } : {}),
          ...(duration > 0 ? { durationUs: duration } : {}),
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
        ae.onInputDiscontinuity = (deltaUs) => {
          log(`Audio input discontinuity: ${driftMs(deltaUs)} (capture stamp vs sample count)`);
        };
      }

      // 6. Wire capture → encoder
      capture!.onVideoFrame = (frame) => {
        noteCapture('video', frame.timestamp, ve.queueDepth);
        ve.encode(frame);
        frame.close();
      };
      capture!.onAudioData = (data) => {
        noteCapture('audio', data.timestamp, audioEncoder?.queueDepth ?? 0);
        audioEncoder?.encode(data);
        data.close();
      };

      // Carry the resolved endpoint and certificate hash into the viewer link.
      const viewerBase = window.location.origin + '/g5-player/';
      const viewerParams = new URLSearchParams();
      viewerParams.set('url', resolvedRelayUrl);
      viewerParams.set('ns', namespace);
      // Draft-18 viewers use the default SUBSCRIBE + Joining FETCH (MSF-01 §5);
      // earlier drafts' FETCH is refused here, so they rely on re-publication.
      if (negotiatedDraft !== 18) viewerParams.set('catalogBootstrap', 'subscribe');
      // A verbose broadcaster hands out a verbose viewer.
      if (debug) viewerParams.set('debug', '1');
      viewerParams.set('v', String(negotiatedDraft));
      const hashParam = params.get('hash');
      if (hashParam) viewerParams.set('hash', hashParam);
      // Viewers of the same relay need the same compat.
      if (compatParam.compat.length) viewerParams.set('compat', compatParam.compat.join(','));
      currentViewerLink = `${viewerBase}?${viewerParams.toString()}`;
      shareBtn.hidden = false;
      // A CMAF catalog appears once its init segments exist (attachCmafInit).
      if (sessionCatalog && (packaging === 'loc' || sessionCatalog.cmaf)) renderCatalogPanel(sessionCatalog);
      if (sessionCatalog && packaging !== 'loc') {
        void attachCmafInit(sessionCatalog).catch((err: unknown) => log(`CMAF init: ${(err as Error)?.message ?? err}`));
      }
      setState('awaiting subscribe', 'starting');
    },
  });

  currentAttempt = attempt;
  try {
    const result = await attempt.run();
    if (result === 'cancelled') return; // superseded — the UI belongs to the replacement
    sessionUpSinceMs = Date.now();
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
  shareBtn.hidden = true;
  currentPublisher = null;
  currentSession = null;
  nsRequestId = null;
  nsBadgeState = { tone: 'idle', detail: 'PUBLISH_NAMESPACE not sent' };
  setupBadgeState = { tone: 'idle', detail: 'No session' };
  currentConnection = null;
  currentTransport = null;
  setText('conn-draft', String(broadcastDraft));
  liveSinceMs = null;
  lastSample = { t: 0, frames: 0, chunks: 0, vBytes: 0, aBytes: 0 };
  startCameraBtn.disabled = false;
  startScreenBtn.disabled = false;
  stopBtn.disabled = true;
}
