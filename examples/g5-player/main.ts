/**
 * G5 Player
 *
 * Plays LOC and CMAF through the relay and instruments what it sees: a metrics
 * row of health counters, three charts on one shared time axis, the catalog,
 * and a transport panel. Built on openmoq/moq-playa; the engine is
 * theirs, the instrument is not.
 */

import { Player, pickCaptureTime } from '@openmoq/playa';
import type { CaptureTimeSource } from '@openmoq/playa';
import { initBuildInfo } from '../shared/build-info.js';
import {
  namespace, certHash, draftVersion, catalogBootstrap,
  renderCushionFloorMs, renderCushionMaxMs, targetLatencyMs as targetLatencyOverrideMs, debug,
} from '../shared/cert.js';
import { parseCompat } from '../shared/compat.js';
import { orderCatalogForDisplay } from '../shared/msf-order.js';
import {
  FreezeWatch, noteSeq, rebaseSeqs, stallsCell, SETTLE_WINDOW_MS, type ObjSeq,
} from './counters.js';
import {
  readMdhdTimescale, readSegmentTimeRanges, readTrexDefaults, type TrexDefaults,
} from '../../packages/browser/src/mp4-box.js';

/** `?status=1` shows the playback state over the picture (off by default). */
const showStatus = new URLSearchParams(location.search).get('status') === '1';

/** `?compat=`: opt-in interop for a non-conformant relay (shared/compat.ts). */
const compatParam = parseCompat(new URLSearchParams(location.search).get('compat'));

/** `?locmaf=frame`: LOCMAF tracks through WebCodecs instead of MSE (the default). */
const locmafFrame = new URLSearchParams(location.search).get('locmaf') === 'frame';
/** G5 starts from the current group unless `?warmStart=0`. */
const warmStart = new URLSearchParams(location.search).get('warmStart') !== '0';
/** Media recovers in a background tab unless `?autoResume=0`. */
const autoResume = new URLSearchParams(location.search).get('autoResume') !== '0';

/** `?catchUp=1.1`: max playback rate for chasing the catalog targetLatency (>= 1). */
const catchUpRate: number | undefined = (() => {
  const v = Number(new URLSearchParams(location.search).get('catchUp'));
  return Number.isFinite(v) && v >= 1 ? v : undefined;
})();

/** `?congestionControl=low-latency|throughput`: a hint to the browser's QUIC
 *  congestion controller. Unset leaves the browser default. */
const congestionControl: 'low-latency' | 'throughput' | undefined = (() => {
  const v = new URLSearchParams(location.search).get('congestionControl');
  return v === 'low-latency' || v === 'throughput' ? v : undefined;
})();
import { resolveRelayEndpoint, onDiscoveryAttempt } from '../shared/relay-endpoint.js';
import { attachRelayPicker, DEFAULT_RELAY } from '../shared/relay-list.js';
import { copyOnClick } from '../shared/copyable.js';
import { setBadge } from '../shared/status-badge.js';
import type { BadgeTone } from '../shared/status-badge.js';
import type { SubscriptionStatus } from '@openmoq/playa';
import type { Level } from '@openmoq/playa';
import { ClockDriftEstimator } from '../shared/clock-drift.js';
import { ClockReference, describeClockOffset } from '../shared/clock-sync.js';

// ─── DOM refs & helpers ─────────────────────────────────────────────

const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const seekBar = document.getElementById('seek') as HTMLInputElement;
const timeDisplay = document.getElementById('time')!;
const volumeBar = document.getElementById('volume') as HTMLInputElement;
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const qualitySelect = document.getElementById('quality') as HTMLSelectElement;
const programSelect = document.getElementById('program') as HTMLSelectElement;
const viewSelect = document.getElementById('view') as HTMLSelectElement;
const langSelect = document.getElementById('lang') as HTMLSelectElement;
const stateBadge = document.getElementById('state')!;
stateBadge.hidden = !showStatus;
const diagGrid = document.getElementById('diag-grid')!;
const advGrid = document.getElementById('adv-grid')!;
const advPanel = document.getElementById('adv-panel') as HTMLDetailsElement;
const latSpark = document.getElementById('lat-spark') as HTMLCanvasElement;
const jitSpark = document.getElementById('jit-spark') as HTMLCanvasElement;
const cusSpark = document.getElementById('cus-spark') as HTMLCanvasElement;
const cusAVal = document.getElementById('cus-a')!;
const cusVVal = document.getElementById('cus-v')!;
const cusDVal = document.getElementById('cus-d')!;
const cusTarget = document.getElementById('cus-target')!;
const cusCushion = document.getElementById('cus-cushion')!;
const latVal = document.getElementById('lat-val')!;
const latP95 = document.getElementById('lat-p95')!;
const latMax = document.getElementById('lat-max')!;
const latScreen = document.getElementById('lat-screen')!;
const latKind = document.getElementById('lat-kind')!;
const latLabel = document.getElementById('lat-label')!;
const jitVal = document.getElementById('jit-val')!;
const catalogPanel = document.getElementById('catalog-panel')!;
const catMeta = document.getElementById('cat-meta')!;
const catSize = document.getElementById('cat-size')!;
const catTracks = document.getElementById('cat-tracks')!;
const catJson = document.getElementById('cat-json')!;
const catToggle = document.getElementById('cat-toggle') as HTMLButtonElement;
const catView = document.getElementById('cat-view') as HTMLButtonElement;
const setupBadge = document.getElementById('setup-badge')!;
const nsBadge = document.getElementById('ns-badge')!;
const catBadge = document.getElementById('cat-badge')!;
const catCopy = document.getElementById('cat-copy') as HTMLButtonElement;
const logCopy = document.getElementById('log-copy') as HTMLButtonElement;
const catRestore = document.getElementById('cat-restore') as HTMLButtonElement;
const layoutEl = document.getElementById('layout')!;
const logEl = document.getElementById('log')!;
const playerContainer = document.getElementById('player-container')!;

const setText = (id: string, value: string): void => {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
};

/** Lines kept; the oldest are dropped past this. */
const MAX_LOG_LINES = 2000;

/** Metrics-row hover text. */
const CELL_TIPS: Record<string, string> = {
  'ttff': 'Connection start to first frame drawn.',
  'bitrate a/v': 'Received kbps, audio/video.',
  'reorder a/v': 'Out-of-order arrivals, audio/video. Small: slowest to settle.',
  'lag': 'Worst page stall. Hundreds of ms: page blocked or throttled.',
  'clk drift': 'Publisher clock vs this browser, ms/min. Removed from the latency chart once steady.',
  'slowest t/a/d': 'Slowest object: transfer / assembly / dispatch ms. Small: its size.',
  'resyncs': 'A/V sync reference re-anchored.',
  'underruns': 'Audio ran dry. Small: total silence.',
  'late/snap': 'Audio dropped late before decode / snapped to the live edge.',
  'dropped': "Video frames the browser didn't draw.",
  'obj lost a/v': 'Objects that never arrived, audio/video.',
  'stalls': 'Time playback was interrupted.',
};

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  });
  logEl.append(`[${ts}] ${msg}\n`);
  while (logEl.childNodes.length > MAX_LOG_LINES) logEl.firstChild!.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── Settings modal ──────────────────────────────────────────────────

{
  /** Rewritten on apply. Every other param in the URL is carried over, so
   *  multi-valued and unlisted ones (nsField) survive a round trip. */
  const MANAGED = ['url', 'ns', 'v', 'targetLatency', 'cushion', 'cushionMax',
    'catchUp', 'catalogBootstrap', 'warmStart', 'autoResume', 'congestionControl', 'authority', 'hash', 'status', 'debug'];

  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const backdrop = byId('settings-backdrop');
  const fUrl = byId<HTMLInputElement>('s-url');
  const relayPicker = attachRelayPicker(fUrl);
  const fNs = byId<HTMLInputElement>('s-ns');
  const fV = byId<HTMLSelectElement>('s-v');
  const fTarget = byId<HTMLInputElement>('s-target');
  const fCushion = byId<HTMLInputElement>('s-cushion');
  const fCushionMax = byId<HTMLInputElement>('s-cushion-max');
  const fCatchUp = byId<HTMLInputElement>('s-catchup');
  const fBootstrap = byId<HTMLSelectElement>('s-bootstrap');
  const fWarmStart = byId<HTMLInputElement>('s-warm-start');
  const fAutoResume = byId<HTMLInputElement>('s-auto-resume');
  const fCc = byId<HTMLSelectElement>('s-cc');
  const fAuthority = byId<HTMLInputElement>('s-authority');
  const fHash = byId<HTMLInputElement>('s-hash');
  const fStatus = byId<HTMLInputElement>('s-status');
  const fDebug = byId<HTMLInputElement>('s-debug');
  const advSec = byId<HTMLDetailsElement>('s-adv');

  const close = (): void => backdrop.classList.remove('visible');

  function populate(): void {
    const p = new URLSearchParams(location.search);
    fUrl.value = p.get('url') ?? '';
    relayPicker.sync();
    fNs.value = p.get('ns') ?? '';
    fV.value = p.get('v') ?? '';
    fTarget.value = p.get('targetLatency') ?? '';
    fCushion.value = p.get('cushion') ?? '';
    fCushionMax.value = p.get('cushionMax') ?? '';
    fCatchUp.value = p.get('catchUp') ?? '';
    fBootstrap.value = p.get('catalogBootstrap') ?? '';
    fWarmStart.checked = p.get('warmStart') !== '0';
    fAutoResume.checked = p.get('autoResume') !== '0';
    fCc.value = p.get('congestionControl') ?? '';
    fAuthority.value = p.get('authority') ?? '';
    fHash.value = p.get('hash') ?? '';
    fStatus.checked = p.get('status') === '1';
    fDebug.checked = p.get('debug') === '1';
    // Open Advanced when anything in it is set, so a non-default is never hidden.
    advSec.open = MANAGED.slice(3).some((k) => p.has(k));
  }

  byId('settings-btn').addEventListener('click', () => { populate(); backdrop.classList.add('visible'); });
  byId('set-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('visible')) close();
  });
  // Enter in a field applies, as a form submit would; buttons and the
  // Advanced toggle keep their own Enter.
  backdrop.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT') return;
    e.preventDefault();
    byId('set-apply').click();
  });

  byId('set-apply').addEventListener('click', () => {
    const next = new URLSearchParams(location.search);
    for (const k of MANAGED) next.delete(k);
    // A blank field means "use the default", and a default is never written —
    // the URL stays short enough to paste.
    const set = (k: string, v: string): void => { if (v) next.set(k, v); };
    set('url', fUrl.value.trim());
    const ns = fNs.value.trim();
    if (ns && ns !== 'live') next.set('ns', ns);
    set('v', fV.value);
    set('targetLatency', fTarget.value.trim());
    set('cushion', fCushion.value.trim());
    set('cushionMax', fCushionMax.value.trim());
    set('catchUp', fCatchUp.value.trim());
    set('catalogBootstrap', fBootstrap.value);
    if (!fWarmStart.checked) next.set('warmStart', '0');
    if (!fAutoResume.checked) next.set('autoResume', '0');
    set('congestionControl', fCc.value);
    set('authority', fAuthority.value.trim());
    set('hash', fHash.value.trim());
    if (fStatus.checked) next.set('status', '1');
    if (fDebug.checked) next.set('debug', '1');
    const qs = next.toString();
    location.href = location.pathname + (qs ? `?${qs}` : '');
  });
}

/** Copy to the clipboard, confirming in the button itself. */
function wireCopy(btn: HTMLButtonElement, text: () => string): void {
  btn.addEventListener('click', async () => {
    const restore = btn.textContent;
    try {
      await navigator.clipboard.writeText(text());
      btn.textContent = 'copied';
    } catch {
      // Denied permission, or no clipboard outside a secure context.
      btn.textContent = 'blocked';
    }
    setTimeout(() => { btn.textContent = restore; }, 1200);
  });
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Main ───────────────────────────────────────────────────────────
// Explicit ?url= is used as-is; otherwise the shared discovery probes the
// page host's common endpoint paths and, when none answers, falls back to the
// default relay. A failing explicit ?url= renders the diagnostic and stops —
// no rethrow, no unhandled page error.

async function main(): Promise<void> {
  initBuildInfo(log);
  log('Discovering relay endpoint...');
  onDiscoveryAttempt((url, outcome) => log(`  probe ${url}: ${outcome}`));
  let relayUrl: string;
  try {
    relayUrl = await resolveRelayEndpoint();
  } catch (err) {
    if (new URLSearchParams(location.search).get('url')) {
      log(`Fatal: ${(err as Error).message}`);
      stateBadge.textContent = 'error';
      stateBadge.className = 'state-badge error';
      return;
    }
    log(`${(err as Error).message}; using ${DEFAULT_RELAY}`);
    relayUrl = DEFAULT_RELAY;
  }

  // ── Create Player ─────────────────────────────────────────────────

  // Engine-level options reach MoqtPlayer only via moqtPlayerConfig.
  const engineConfig = {
    ...(catalogBootstrap ? { catalogBootstrap } : {}),
    ...(warmStart ? { warmStartCurrentGroup: true } : {}),
    ...(autoResume ? {} : { autoResume: false }),
    ...(catchUpRate ? { maxCatchUpRate: catchUpRate } : {}),
    ...(renderCushionFloorMs ? { renderCushionFloorMs } : {}),
    ...(renderCushionMaxMs ? { renderCushionMaxMs } : {}),
    ...(debug ? { logLevel: 'debug' as const } : {}),
    ...(compatParam.compat.length ? { compat: compatParam.compat } : {}),
    ...(locmafFrame ? { locmafDecoding: 'frame' as const } : {}),
    // SUB_NS: report the namespace and re-establish when it is published again.
    followNamespace: true,
  };
  if (compatParam.unknown.length) log(`Ignoring unknown compat: ${compatParam.unknown.join(', ')}`);
  /** Compat activity, logged when it changes (the engine's own warnings go to the console). */
  let compatReported = '';
  const reportCompat = (): void => {
    const unanswered: number = (player as any).engine?.connection?.unansweredUpdateCount ?? 0;
    if (!compatParam.compat.length && !unanswered) return;
    const credit = (player as any).engine?.connection?.session?.uncappedRequestCredit;
    const flagged = compatParam.compat.length
      ? `requests sent without credit ${credit?.requests ?? 0}`
        + (credit?.active ? ' (relay has granted none)' : '')
        + ` · empty media objects skipped ${(player as any).engine?.emptyMediaObjectsSkipped ?? 0}`
      : '';
    // Tolerated by default: the relay ended a subscription before answering its updates.
    const line = [flagged, unanswered ? `updates left unanswered by PUBLISH_DONE ${unanswered}` : '']
      .filter(Boolean).join(' · ');
    if (line === compatReported) return;
    compatReported = line;
    log(`compat: ${line}`);
  };
  const player = new Player(playerContainer, {
    url: relayUrl,
    namespace,
    autoplay: true,
    ...(certHash ? { certHash } : {}),
    ...(draftVersion ? { draftVersion } : {}),
    ...(congestionControl ? { congestionControl } : {}),
    ...(targetLatencyOverrideMs ? { targetLatencyMs: targetLatencyOverrideMs } : {}),
    moqtPlayerConfig: engineConfig,
  });
  const optionSummary = Object.entries({ ...engineConfig, targetLatencyMs: targetLatencyOverrideMs })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  if (optionSummary) log(`Options: ${optionSummary}`);

  // ── Wire Events ───────────────────────────────────────────────────

  player.on('statechange', ({ state }) => {
    stateBadge.textContent = state;
    stateBadge.className = `state-badge ${state}`;
    if (state === 'error') setupBadgeState = { tone: 'bad', detail: 'Session ended in a fatal error' };
  });

  // ── MoQT state badges ─────────────────────────────────────────────
  // SETUP is the session; each FWD is one SUBSCRIBE: grey none or awaiting
  // SUBSCRIBE_OK, yellow Forward State 0, green objects arriving, red silent.

  let setupBadgeState: { tone: BadgeTone; detail: string } = { tone: 'idle', detail: 'No session' };
  /** The catalog SUBSCRIBE can be accepted long before any catalog arrives. */
  let catalogArrived = false;
  let catalogWaitSinceMs: number | null = null;
  let catalogWaitLogged = false;
  let lastCatalogPhase: string | null = null;
  // Catalog retrieval steps worth a log line; the normal join passes through
  // 'joining' and 'fetching' too briefly to report.
  const CATALOG_PHASE_TEXT: Record<string, string> = {
    joining: 'Joining FETCH sent with the SUBSCRIBE',
    fetching: 'FETCH for the catalog in flight',
    'empty-wait': 'the relay reported the track empty; waiting on the subscription',
    'await-first-payload': 'FETCH completed without a catalog; waiting on the subscription',
    'await-newer-head': 'waiting for a newer catalog group',
    'fallback-legacy': 'falling back to subscribe-only retrieval',
    fatal: 'catalog retrieval failed',
  };
  const QUIET_CATALOG_PHASES = new Set(['idle', 'joining', 'fetching', 'ready', 'live', 'aborted']);
  // SUB_NS follows the namespace: yellow sent, accepted or withdrawn; green published; red refused.
  let nsBadgeState: { tone: BadgeTone; detail: string } = { tone: 'idle', detail: 'SUBSCRIBE_NAMESPACE not sent' };
  const NS_TONE: Record<string, BadgeTone> = {
    pending: 'wait', listening: 'wait', published: 'ok', withdrawn: 'wait', refused: 'bad',
  };
  /** Last data object per media type, for a subscription gone silent. */
  const lastArrivalMs: { video?: number; audio?: number } = {};
  const SILENT_MS = 1_000;
  /** Silence is counted from the resume, not across the pause. */
  let resumedAtMs = -Infinity;
  player.on('play', () => { resumedAtMs = performance.now(); });
  const subscriptionBadge = (el: HTMLElement, sub: SubscriptionStatus | undefined, nowMs: number): void => {
    if (!sub) { setBadge(el, 'FWD --', 'idle', 'No subscription'); return; }
    const req = `SUBSCRIBE reqId=${sub.requestId}${sub.alias !== null ? ` · alias=${sub.alias}` : ''}`;
    if (!sub.established) { setBadge(el, 'FWD …', 'idle', `${req} sent; awaiting SUBSCRIBE_OK`); return; }
    if (!sub.forward) { setBadge(el, 'FWD 0', 'wait', `${req} · Forward State 0: paused by this player`); return; }
    const arrived = sub.kind === 'video' || sub.kind === 'audio' ? lastArrivalMs[sub.kind] : undefined;
    const last = arrived === undefined ? undefined : Math.max(arrived, resumedAtMs);
    if (last !== undefined && nowMs - last > SILENT_MS && player.state === 'playing') {
      setBadge(el, 'FWD 1', 'bad',
        `${req} · Forward State 1, but nothing has arrived for ${((nowMs - last) / 1000).toFixed(1)}s`);
      return;
    }
    setBadge(el, 'FWD 1', 'ok', `${req} · Forward State 1`);
  };
  const renderStatusBadges = (nowMs: number): void => {
    setBadge(setupBadge, 'SETUP', setupBadgeState.tone, setupBadgeState.detail);
    setBadge(nsBadge, 'SUB_NS', nsBadgeState.tone, nsBadgeState.detail);
    const subs = player.subscriptions;
    const catSub = subs.find((s) => s.kind === 'catalog');
    const phase = player.catalogBootstrapPhase;
    if (!catalogArrived && phase !== null && phase !== lastCatalogPhase) {
      lastCatalogPhase = phase;
      if (!QUIET_CATALOG_PHASES.has(phase)) {
        log(`Catalog retrieval: ${CATALOG_PHASE_TEXT[phase] ?? phase}`);
      }
    }
    if (catSub?.established && catSub.forward && !catalogArrived) {
      catalogWaitSinceMs ??= nowMs;
      const step = phase === null ? 'subscribe-only' : (CATALOG_PHASE_TEXT[phase] ?? phase);
      if (!catalogWaitLogged && nowMs - catalogWaitSinceMs > 5_000) {
        catalogWaitLogged = true;
        log(`No catalog 5s after SUBSCRIBE_OK (${step})`);
      }
      setBadge(catBadge, 'FWD 1', 'wait',
        `SUBSCRIBE reqId=${catSub.requestId} · Forward State 1, but no catalog yet: ${step}`);
    } else {
      subscriptionBadge(catBadge, catSub, nowMs);
    }
    for (const el of catTracks.querySelectorAll<HTMLElement>('.badge[data-track]')) {
      subscriptionBadge(el, subs.find((s) => s.kind !== 'catalog' && s.trackName === el.dataset['track']), nowMs);
    }
  };

  const logCongestionControl = (): void => log(`Congestion control: requested `
    + `${congestionControl ?? 'browser default'}, browser applied ${player.congestionControl ?? 'not reported'}`);

  player.on('ready', ({ levels }) => {
    log(`Ready: ${levels.length} quality level(s)`);
    setupBadgeState = { tone: 'ok', detail: 'Session established' };
    logCongestionControl();
    playBtn.disabled = false;
    muteBtn.disabled = false;
    qualitySelect.disabled = false;
    fillQuality(levels);
    fillTrackPickers();
  });

  // The quality ladder is the current view's; a view switch replaces it.
  function fillQuality(levels: readonly Level[]): void {
    qualitySelect.innerHTML = '<option value="auto">Auto</option>';
    for (const level of levels) {
      const opt = document.createElement('option');
      opt.value = String(level.index);
      opt.textContent = `${level.label} (${Math.round(level.bitrate / 1000)}k)`;
      qualitySelect.appendChild(opt);
    }
    qualitySelect.value = player.autoQuality || player.currentLevel < 0 ? 'auto' : String(player.currentLevel);
  }
  player.on('levelsloaded', ({ levels }) => fillQuality(levels));

  // Program / View / Language pickers, shown only when the catalog offers a choice.
  function fillPicker(sel: HTMLSelectElement, options: ReadonlyArray<[string, string]>, current: string | undefined): void {
    sel.replaceChildren(...options.map(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      return opt;
    }));
    if (current !== undefined) sel.value = current;
    sel.hidden = options.length < 2;
  }
  function fillTrackPickers(): void {
    const str = (v: number | undefined): string | undefined => (v === undefined ? undefined : String(v));
    fillPicker(programSelect,
      player.availablePrograms.map((p) => [String(p.renderGroup), `Program ${p.renderGroup}`]),
      str(player.currentProgram));
    fillPicker(viewSelect,
      player.availableViews.map((v) => [String(v.altGroup),
        v.label ?? (v.width && v.height ? `${v.width}×${v.height}` : `View ${v.altGroup}`)]),
      str(player.currentView));
    fillPicker(langSelect,
      player.availableAudioTracks.map((t) => [t.name, t.label ?? t.lang ?? t.name]),
      player.currentAudioTrackName);
  }
  player.on('catalog_updated', () => fillTrackPickers());
  player.on('view_changed', ({ fromView, toView, trackName }) => {
    log(`View: ${fromView ?? '—'} → ${toView ?? '—'} (${trackName})`);
    fillTrackPickers();
  });
  player.on('program_changed', ({ fromProgram, toProgram }) => {
    log(`Program: ${fromProgram ?? '—'} → ${toProgram}`);
    fillTrackPickers();
  });
  player.on('audio_track_changed', ({ toTrackName, lang }) => {
    log(`Audio: ${toTrackName}${lang ? ` (${lang})` : ''}`);
    fillTrackPickers();
  });
  player.on('audio_track_switch_failed', ({ toTrackName, error }) => {
    log(`Audio switch to ${toTrackName} failed: ${error.message}`);
    fillTrackPickers();
  });

  // Each milestone is ms from load(), so the gaps between them say which
  // stage a slow start spent its time in (late joiners differ from the first).
  player.on('playing', () => {
    const b = (player as any).engine?.stats?.ttffBreakdown;
    if (!b) { log('First frame rendered'); return; }
    const ms = (v: number | null) => (v == null ? '—' : v.toFixed(0));
    log(`First frame rendered · transport ${ms(b.transportConnectedMs)}`
      + ` · setup ${ms(b.setupCompleteMs)} · catalog ${ms(b.catalogReceivedMs)}`
      + ` · firstObject ${ms(b.firstObjectReceivedMs)}`
      + ` · decoder ${ms(b.decoderConfiguredMs)} · frame ${ms(b.firstFrameRenderedMs)}`);
  });

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
  // MSE path: buffered ranges at the moment the element stalled ('waiting')
  // and again when the stall ends — a hole that has closed by the end is a
  // late object landing behind the playhead.
  const describeVideo = (video: HTMLVideoElement): string => {
    const r: string[] = [];
    for (let i = 0; i < video.buffered.length; i++) {
      r.push(`[${video.buffered.start(i).toFixed(2)}–${video.buffered.end(i).toFixed(2)}]`);
    }
    return `t=${video.currentTime.toFixed(2)} rs=${video.readyState} rate=${video.playbackRate} `
      + `buffered=${r.join('') || 'none'}${arrivalAges()}`;
  };
  /** How long ago each track's last object arrived: separates a delivery
   *  pause from a stop with media in hand. */
  const arrivalAges = (): string => {
    const now = performance.now();
    const age = (t?: number) => (t === undefined ? '—' : (now - t).toFixed(0));
    return ` last obj v/a ${age(lastArrivalMs.video)}/${age(lastArrivalMs.audio)}ms ago`;
  };
  let watchedVideo: HTMLVideoElement | null = null;
  let stallStartSnap = '';
  const watchVideo = () => {
    const video = playerContainer.querySelector('video');
    if (!video || video === watchedVideo) return video;
    watchedVideo = video;
    video.addEventListener('waiting', () => { stallStartSnap = describeVideo(video); });
    if (debug) {
      // Element-side view of every playhead disturbance, timestamped like
      // the stall lines so the two can be correlated.
      for (const ev of ['play', 'playing', 'pause', 'waiting', 'stalled', 'suspend',
                        'seeking', 'seeked', 'ratechange', 'ended', 'error']) {
        video.addEventListener(ev, () => log(`[video] ${ev} ${describeVideo(video)}`));
      }
    }
    return video;
  };
  // Fires at the detection threshold; the outage length comes with stall_recovered.
  /** CMAF: each SourceBuffer's ranges, which the element's combined range can hide. */
  const describeBuffers = (): string => {
    const text = (player as any).engine?.mediaSource?.describeBuffers?.() as string | undefined;
    return text ? ` · ${text}${audioOrderNote()}` : '';
  };
  type OrderStats = { restored: number; missing: number; late: number; worstLateMs: number };
  /** CMAF decode-order repair so far (CmafAssembler audio/videoOrderStats). */
  const orderStats = (): Array<[string, OrderStats]> => {
    const asm = (player as any).engine?.cmafAssembler;
    return (['audio', 'video'] as const)
      .map((kind): [string, OrderStats | undefined] => [kind, asm?.[`${kind}OrderStats`]])
      .filter((e): e is [string, OrderStats] => e[1] !== undefined);
  };
  const audioOrderNote = (): string => orderStats().map(([kind, o]) => {
    const worst = o.late > 0 && o.worstLateMs ? ` (worst ${o.worstLateMs.toFixed(0)}ms behind)` : '';
    return ` · ${kind} order restored/missing/late ${o.restored}/${o.missing}/${o.late}${worst}`;
  }).join('');
  player.on('stall', ({ durationMs }) => {
    const video = watchVideo();
    const where = video
      ? ` start: ${stallStartSnap || '?'} · end: ${describeVideo(video)}` : '';
    log(`Stall detected after ${durationMs.toFixed(0)}ms${where}${describeBuffers()}`);
    stallMarks.push(performance.now());
    clockDrift.disturb(performance.now());
  });

  player.on('stall_recovered', ({ durationMs }) => {
    stallStartSnap = '';
    clockDrift.disturb(performance.now());
    log(`Stall recovered — outage ${(durationMs / 1000).toFixed(2)}s${describeBuffers()}`);
  });

  // Page suspensions otherwise look like network gaps in the log.
  if ((document as { wasDiscarded?: boolean }).wasDiscarded) {
    log('Page reloaded: the browser discarded this tab while it was in the background');
  }
  player.on('lifecycle', ({ state, awayMs }) => {
    log(awayMs === undefined
      ? `Page ${state}`
      : `Page ${state} after ${(awayMs / 1000).toFixed(1)}s away`);
  });
  player.on('session_closed', ({ code, reason }) => {
    log(`Session closed${code !== undefined ? ` (code ${code})` : ''}${reason ? `: ${reason}` : ''}`);
    setupBadgeState = {
      tone: 'bad',
      detail: `Session closed${code !== undefined ? ` (code ${code})` : ''}${reason ? `: ${reason}` : ''}`,
    };
  });
  player.on('session_reconnecting', ({ attempt, delayMs }) => {
    log(delayMs > 0
      ? `Reconnecting (attempt ${attempt} in ${(delayMs / 1000).toFixed(0)}s)`
      : `Reconnecting (attempt ${attempt})`);
    setupBadgeState = { tone: 'wait', detail: `Session closed; reconnect attempt ${attempt}` };
    rebaseSeqs(objSeq, { dropPending: true });
  });
  player.on('track_unsubscribed', ({ trackName, reason }) => {
    log(`Track "${trackName}" ended: ${reason || '(no reason)'}`);
  });
  player.on('track_subscribe_failed', ({ trackName, mediaType, errorCode, reason }) => {
    log(`Subscribe ${mediaType} "${trackName}" refused (0x${errorCode.toString(16)}): ${reason || '(no reason)'}`);
  });
  player.on('namespace_state', ({ state, detail }) => {
    nsBadgeState = { tone: NS_TONE[state] ?? 'idle', detail };
    if (state === 'published' || state === 'withdrawn' || state === 'refused') log(`SUB_NS: ${detail}`);
  });
  player.on('session_established', () => {
    setupBadgeState = { tone: 'ok', detail: 'SETUP complete: session established' };
    reportCompat();
  });
  player.on('session_migrated', () => {
    log('Session re-established');
    rebaseSeqs(objSeq, { dropPending: true });
    setupBadgeState = { tone: 'ok', detail: 'Session re-established' };
    logCongestionControl();
    // The new session retrieves the catalog again: report its progress too.
    catalogArrived = false;
    lastCatalogPhase = null;
    catalogWaitSinceMs = null;
    catalogWaitLogged = false;
  });
  player.on('error', ({ severity, message }) => log(`[${severity}] ${message}`));

  const renderCushionMs = (): number | null =>
    (player as any).engine?.stats?.loc?.renderCushionMs ?? null;
  let lastSyncResets = 0;
  player.on('stats', (s: any) => {
    const syncResets: number = (player as any).engine?.stats?.loc?.syncResetCount ?? 0;
    if (syncResets > lastSyncResets) {
      log(`Sync reference re-anchored (${syncResets} total)`);
      lastSyncResets = syncResets;
      clockDrift.disturb(performance.now());
    }
    // `unit` renders small and muted after the value; `tone` colours the value
    // by health, so a non-zero fault counter is visible without reading labels.
    const cell = (label: string, v: string, unit = '', tone = '', unitTone = '', tip = CELL_TIPS[label]) =>
      `<div class="cell"${tip ? ` title="${tip}"` : ''}>${label}:<b${tone ? ` class="${tone}"` : ''}>${v}`
      + `${unit ? `<span class="u${unitTone ? ` ${unitTone}` : ''}">${unit}</span>` : ''}</b></div>`;
    // Role, not severity: green measures, amber marks the counters that
    // should stay at zero. Stream identity lives in the catalog panel.
    const NUM = 'num';
    // Amber only once a counter has something to report; white at zero.
    const FAULT = (n: number) => (n > 0 ? 'fault' : '');
    const fmtKbps = (v: number | null): string => (v == null ? '…' : v.toFixed(0));
    // Session-long counters: exact below 10k, then compact (12.3K, 1.20M).
    const fmtCount = (n: number): string => {
      if (n < 10_000) return String(n);
      if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
      return `${(n / 1_000_000).toFixed(2)}M`;
    };
    // One row shape on every path: the LOC gauges (render cushion, skew, audio
    // underruns/late/snap) read n/a on the MSE path; "…" is still measuring.
    const NA = 'na';
    const naTip = (label: string) => `${CELL_TIPS[label]} Not on this stream's path: it plays through MSE.`;
    const cushion = renderCushionMs();
    const locPath = cushion != null || s.avSkewMs != null;
    // Interruptions: playback stalls, including one still going on, plus on MSE
    // the video holes played through (picture frozen while audio continues; no
    // stall is reported).
    const stallsNow = stallsCell({
      stallCount: s.stallCount ?? 0, stallDurationMs: s.stallDurationMs ?? 0,
      ongoingStallMs: s.ongoingStallMs ?? 0, freezes: videoFreezes, frozenSec: videoFrozenSec, locPath,
    });
    // TTFF runs from connection start; the connect share goes in its tooltip.
    const connectMs: number | null = (player as any).engine?.stats?.ttffBreakdown?.setupCompleteMs ?? null;
    noteAudioDatagrams();
    // Compared against the playout cushion, which is on screen and static: a
    // reorder settling inside it is absorbed invisibly, one settling beyond it
    // arrived later than the buffer was sized to cope with. The adaptive gap
    // timeout is the true discard threshold but it moves, which made a frozen
    // value change colour on its own.
    const settleMs = settleMaxMs();
    const lagWorst = Math.max(0, ...lagSamples.map(([, d]) => d));
    const settleTone = targetLatencyMs > 0 && settleMs > targetLatencyMs ? 'fault' : '';
    diagGrid.innerHTML = [
      cell('ttff', s.timeToFirstFrameMs != null ? s.timeToFirstFrameMs.toFixed(0) : '…', 'ms', NUM, '',
        connectMs != null ? `${CELL_TIPS['ttff']} Connect: ${connectMs.toFixed(0)} ms.` : CELL_TIPS['ttff']),
      cell('bitrate a/v', `${fmtKbps(trackKbps('audio'))}/${fmtKbps(trackKbps('video'))}`, 'kbps', NUM),
      // Cross-stream arrival order, not a fault: LOC audio is one group per frame
      // on its own QUIC stream and independent streams carry no ordering between
      // them. The settle time is the one with a cliff in front of it — past the
      // adaptive gap timeout the object is discarded and costs a sync reset — so
      // it, not the count, is what goes amber.
      cell('reorder a/v',
        `${fmtCount(seqStat('audio', 'reorders'))}/${fmtCount(seqStat('video', 'reorders'))}`,
        `&le;${settleMs.toFixed(0)}ms`, NUM, settleTone),
      // Worst event-loop lag in the window. Tens of ms is ordinary scheduling;
      // hundreds means the thread is blocked or the tab is being throttled.
      cell('lag', lagSamples.length ? lagWorst.toFixed(0) : '…', 'ms',
        lagWorst > 100 ? 'fault' : NUM),
      // Clock divergence removed from the latency chart; amber past 10 ms/min.
      cell('clk drift',
        clockDriftMsPerMin != null ? clockDriftMsPerMin.toFixed(1) : '…', 'ms/min',
        clockDriftMsPerMin != null && Math.abs(clockDriftMsPerMin) > 10 ? 'fault' : NUM, '',
        clockDriftMsPerMin != null ? CELL_TIPS['clk drift']
          : `${CELL_TIPS['clk drift']} Measuring: needs a few undisturbed minutes; hiding the page restarts it.`),
      // Worst object in the window: transit / reassembly / routing ms, then its size.
      cell('slowest t/a/d', worstDelivery(), worstDeliverySize(),
        worstDeliveryLocalMs() > 50 ? 'fault' : NUM, '',
        worstSpan() !== null ? CELL_TIPS['slowest t/a/d']
          : `${CELL_TIPS['slowest t/a/d']} No object measured yet.`),
      // Queue depths are on the queued chart; this row is facts and fault counts.
      ...(locPath ? [
        cell('resyncs', fmtCount(syncResets), '', FAULT(syncResets)),
        // Count, then the silence they left.
        cell('underruns', fmtCount(s.audioUnderruns ?? 0),
          `${((player as any).audioOutput?.underrunGapSec ?? 0).toFixed(1)}s`,
          FAULT(s.audioUnderruns ?? 0)),
        // Why audio underran: dropped late before decode / snapped by the output clamp.
        cell('late/snap',
          `${fmtCount((player as any).engine?.stats?.loc?.audioLateDrops ?? 0)}`
          + `/${fmtCount((player as any).audioOutput?.liveEdgeSnapCount ?? 0)}`, '',
          FAULT(((player as any).engine?.stats?.loc?.audioLateDrops ?? 0)
            + ((player as any).audioOutput?.liveEdgeSnapCount ?? 0))),
      ] : [
        cell('resyncs', 'n/a', '', NA, '', naTip('resyncs')),
        cell('underruns', 'n/a', '', NA, '', naTip('underruns')),
        cell('late/snap', 'n/a', '', NA, '', naTip('late/snap')),
      ]),
      cell('dropped', fmtCount(s.framesDropped ?? 0), '', FAULT(s.framesDropped ?? 0)),
      // An id that never arrived: a frame missing inside a buffered range, which
      // nothing else on this panel can see.
      cell('obj lost a/v',
        `${fmtCount(seqStat('audio', 'lost'))}/${fmtCount(seqStat('video', 'lost'))}`, '',
        FAULT(seqStat('video', 'lost') + seqStat('audio', 'lost'))),
      cell('stalls', stallsNow.sec.toFixed(1), 's', FAULT(stallsNow.faults), '',
        `${CELL_TIPS['stalls']} ${stallsNow.detail}`),
    ].join('');
  });

  // ── Latency & jitter sparklines (from media_object arrivals) ─────

  // Latency is wall-clock: arrival minus the publisher's capture stamp,
  // so it reads true only when both clocks agree. A systematic negative
  // offset is reported as clock skew rather than silently dropped.
  //
  // Jitter is RFC 3550 §6.4.1 interarrival jitter — the smoothed
  // deviation between arrival spacing and capture spacing, which
  // separates network jitter from the publisher's own pacing. Without
  // capture timestamps it degrades to arrival-interval deviation.

  // Raw per-object latency with arrival times, trimmed to a window. The chart
  // series below are filled on the tick instead of per object and drawn against
  // the tick's time, so every chart shares one time axis and features line up.
  const TICK_MS = 250;
  /** Time span each chart shows. */
  const CHART_SPAN_MS = 45_000;
  /** Tick times; every chart series holds one value per entry. */
  const sampleAtMs: number[] = [];
  /** [arrival ms, latency ms, group]: the group lets a timeline jump take its samples back out. */
  const latWindow: Array<[number, number, bigint | undefined]> = [];
  const LAT_WINDOW_MS = 4_000;
  /** latWindow's samples over every charted tick's window, for recomputing them after a jump. */
  const latHistory: Array<[number, number, bigint | undefined]> = [];
  /** Clock divergence rate from the drift fit, in ms per minute. */
  let clockDriftMsPerMin: number | null = null;
  /** Fitted from the latency floor; stalls, re-anchors and returns to view unsettle it. */
  const clockDrift = new ClockDriftEstimator();
  // Latency compares this machine's clock with the publisher's. The relay
  // site's /time (?clockUrl= overrides) calibrates it; without an answer the
  // figures read this clock uncorrected, and the label's hover says so.
  const clockUrl = new URLSearchParams(location.search).get('clockUrl') ?? new URL('/time', location.href).href;
  let clockMissingLogged = false;
  const referenceClock = new ClockReference(clockUrl, {
    onAdopt: (o) => {
      log(`Clock: ${describeClockOffset(o, clockUrl)}; latency corrected`);
      clockDrift.disturb(performance.now());
    },
    onFail: () => {
      if (clockMissingLogged || referenceClock.offset !== null) return;
      clockMissingLogged = true;
      log(`Clock: no reference at ${clockUrl}; latency uses this machine's clock`);
    },
  });
  const calibrateClock = (): Promise<void> => referenceClock.calibrate();
  /** Date.now() on the reference clock. */
  const wallNowMs = (): number => referenceClock.nowMs();
  void calibrateClock();
  setInterval(() => { void calibrateClock(); }, 300_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void calibrateClock(); });
  let clockDriftApplied = false;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clockDrift.disturb(performance.now());
  });
  // Both curves are the printed p50 and p95 over the same window, so the lines
  // and the numbers cannot disagree. Max stays a readout: as a curve it is one
  // sample wide and reads as noise.
  const latP50Samples: number[] = [];
  const latP95Samples: number[] = [];
  // Per-tick worst of the samples that arrived during that tick, so MAX covers
  // exactly the charted span. p95 over ~120 samples cannot be moved by a lone
  // spike, so this is the only series here that sees one; its peak is marked.
  const latTickMaxSamples: number[] = [];
  /** Worst raw latency since the previous tick. */
  let tickWorstRawMs = -Infinity;
  let lastDriftCorrectionMs = 0;
  /** Audio arrival latency, kept like latWindow: its tail is what the audio queue must absorb. */
  const audioLatWindow: Array<[number, number, bigint | undefined]> = [];
  /** Audio arrival p50/p95/p99 over the window, drift-corrected. */
  let audioLatPct: [number, number, number] | null = null;
  /** CMAF: estimated capture-to-screen latency, arrival p50 plus the video buffered ahead. */
  let cmafPlayoutMs: number | null = null;
  const playoutWindow: Array<[number, number]> = [];
  /** LOC: capture-to-paint age of each frame drawn, kept like latWindow. */
  const screenWindow: Array<[number, number]> = [];
  const noteFrameDrawn = (captureUs: number, drawnAtWallMs: number): void => {
    const ageMs = drawnAtWallMs + (referenceClock.offset?.offsetMs ?? 0) - captureUs / 1000;
    if (Math.abs(ageMs) < 120_000) screenWindow.push([performance.now(), ageMs]);
  };
  /** Underruns since the last report: buffers late past their slot, buffers on
   *  time after missing audio, silence, and the worst lateness. */
  const UNDERRUN_REPORT_MS = 10_000;
  const emptyUnderrunWindow = () => ({ count: 0, late: 0, onTime: 0, gapSec: 0, worstLateSec: 0 });
  let underrunWindow = emptyUnderrunWindow();
  let underrunReportAtMs = 0;
  let audioOrderReported = '';
  let staleDropsReported = 0;
  let staleDropsReportedAtMs = 0;
  const noteUnderrun = (gapSec: number, lateSec: number | null): void => {
    underrunWindow.count++;
    underrunWindow.gapSec += gapSec;
    if (lateSec === null) return;
    if (lateSec > 0) {
      underrunWindow.late++;
      underrunWindow.worstLateSec = Math.max(underrunWindow.worstLateSec, lateSec);
    } else {
      underrunWindow.onTime++;
    }
  };
  const jitSamples: number[] = [];
  // Per-track queued media ahead of the playhead, one sample per tick.
  const queuedASamples: number[] = [];
  const queuedVSamples: number[] = [];
  // Event-loop lag: how late a timer that does nothing actually runs. The 250 ms
  // tick below cannot measure this — setInterval waits for its own callback, so
  // its period carries this page's draw cost. A bare probe carries only
  // contention: other work blocking the thread, or Chrome clamping timers toward
  // 1 Hz for a tab that is hidden or inaudible. Either starves every stage of the
  // pipeline and surfaces downstream as queue oscillation.
  const LAG_PERIOD_MS = 50;
  const lagSamples: Array<[number, number]> = [];
  let lagDueAt = 0;
  let lastChaseNoteMs = 0;
  const lagProbe = (): void => {
    const now = performance.now();
    // A hidden page's timers are clamped by Chrome; that is not this page's lag.
    if (lagDueAt && !document.hidden) lagSamples.push([now, Math.max(0, now - lagDueAt)]);
    while (lagSamples.length && now - lagSamples[0]![0] > SETTLE_WINDOW_MS) {
      lagSamples.shift();
    }
    lagDueAt = now + LAG_PERIOD_MS;
    setTimeout(lagProbe, LAG_PERIOD_MS);
  };
  setTimeout(lagProbe, LAG_PERIOD_MS);
  // The probe armed before a visibility change fires late; it must not sample.
  document.addEventListener('visibilitychange', () => { lagDueAt = 0; });
  /** Stall detection times, drawn over the queue chart. */
  const stallMarks: number[] = [];
  let targetLatencyMs = 0;
  let audioCodec: string | null = null;
  let videoFps: number | null = null;
  let prevArrivalMs = 0;
  let prevCaptureMs = 0;
  let jitterEwma = 0;
  let expectedIntervalMs = 0;
  /** Media-time stamps carry no capture clock: delay is drawn above its lowest value. */
  let relativeDelay = false;
  let relativeBaseMs: number | null = null;
  /** Where the video capture time behind the latency chart comes from. */
  let latencySource: CaptureTimeSource | null = null;
  const SOURCE_TIP: Record<CaptureTimeSource, string> = {
    property: 'Capture time from the MOQT timestamp properties.',
    loc: 'Capture time from the LOC Timestamp.',
    prft: 'Capture time from CMAF prft, once per group.',
  };
  /** Per track: each other capture-time source minus the one in use, ms. */
  const timingDiffs = new Map<string, { n: number; min: number; max: number; sum: number }>();
  const timingErrorsSeen = new Set<string>();
  let timingLogAtMs = performance.now();
  const noteTiming = (e: any, picked: { source: CaptureTimeSource; us: number } | undefined): void => {
    if (e.timingError && !timingErrorsSeen.has(`${e.trackName}: ${e.timingError}`)) {
      timingErrorsSeen.add(`${e.trackName}: ${e.timingError}`);
      log(`timing ${e.trackName}: ${e.timingError}; its timestamp properties are ignored`);
    }
    if (!picked) return;
    for (const [source, us] of Object.entries(e.captureTimes ?? {}) as [CaptureTimeSource, number][]) {
      if (source === picked.source) continue;
      const key = `${e.mediaType} ${source} − ${picked.source}`;
      const d = (us - picked.us) / 1000;
      const st = timingDiffs.get(key);
      if (!st) timingDiffs.set(key, { n: 1, min: d, max: d, sum: d });
      else { st.n++; st.sum += d; st.min = Math.min(st.min, d); st.max = Math.max(st.max, d); }
    }
    const nowMs = performance.now();
    if (timingDiffs.size && nowMs - timingLogAtMs >= 30_000) {
      timingLogAtMs = nowMs;
      for (const [key, st] of timingDiffs) {
        log(`timing ${key} min/mean/max ${st.min.toFixed(1)}/${(st.sum / st.n).toFixed(1)}/${st.max.toFixed(1)} ms (n=${st.n})`);
      }
    }
  };
  (window as any).__player = player;
  const chartSeries = [sampleAtMs, latP50Samples, latP95Samples, latTickMaxSamples,
    jitSamples, queuedASamples, queuedVSamples];
  /** Drop samples and stall marks older than the chart span. */
  const trimSamples = (nowMs: number): void => {
    while (sampleAtMs.length && nowMs - sampleAtMs[0]! > CHART_SPAN_MS) {
      for (const s of chartSeries) s.shift();
    }
    while (stallMarks.length && nowMs - stallMarks[0]! > CHART_SPAN_MS) stallMarks.shift();
  };

  // Series carry NaN for "nothing to report" so the charts stay on one axis;
  // readouts must skip those rather than print them.
  const lastFinite = (a: number[]): number | null => {
    for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i]!)) return a[i]!;
    return null;
  };
  const maxFinite = (a: number[]): number | null => {
    const f = a.filter(Number.isFinite);
    return f.length ? Math.max(...f) : null;
  };

  const percentile = (a: number[], p: number): number => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  };

  /** The object with the worst socket-to-engine total in the window. */
  type DeliverySpan =
    { transferMs: number; assemblyMs: number; decodeMs: number; bytes: number };
  const worstSpan = (): DeliverySpan | null => {
    const spans = (player as any).engine?.deliveryBreakdown as DeliverySpan[] | undefined;
    if (!spans?.length) return null;
    let worst = spans[0]!;
    let worstTotal = -1;
    for (const s of spans) {
      const total = s.transferMs + s.assemblyMs + s.decodeMs;
      if (total > worstTotal) { worstTotal = total; worst = s; }
    }
    return worst;
  };
  const worstDelivery = (): string => {
    const s = worstSpan();
    return s === null ? '…'
      : `${s.transferMs.toFixed(0)}/${s.assemblyMs.toFixed(0)}/${s.decodeMs.toFixed(0)}`;
  };
  /** The worst object's size, shown in the unit slot. */
  const worstDeliverySize = (): string => {
    const s = worstSpan();
    return s === null ? '' : `ms @${(s.bytes / 1024).toFixed(0)}K`;
  };
  /** The share of the worst object that was spent in this stack, not in transit. */
  const worstDeliveryLocalMs = (): number => {
    const s = worstSpan();
    return s === null ? 0 : s.assemblyMs + s.decodeMs;
  };

  // Per-track object continuity (counters.ts).
  const objSeq: Record<string, ObjSeq> = {};
  const seqStat = (t: string, k: 'reorders' | 'lost'): number => objSeq[t]?.[k] ?? 0;
  const settleMaxMs = (): number => {
    let worst = 0;
    for (const s of Object.values(objSeq)) {
      for (const [, ms] of s.settles) if (ms > worst) worst = ms;
    }
    return worst;
  };
  // Payload bytes with arrival times, trimmed to a 5 s window: the measured
  // media bitrate, as distinct from the catalog's declared figure and from
  // wire goodput in the transport panel (which counts MOQT and QUIC overhead).
  const byteLog: Record<string, Array<[number, number]>> = { video: [], audio: [] };
  const BITRATE_WINDOW_MS = 5_000;
  const trackKbps = (t: string): number | null => {
    const w = byteLog[t];
    if (!w || w.length < 2) return null;
    const span = w[w.length - 1]![0] - w[0]![0];
    if (span < 500) return null;
    const total = w.reduce((n, [, b]) => n + b, 0);
    return (total * 8) / span;   // bytes/ms * 8 = kbit/s
  };
  const noteObject = (e: any): void => {
    const t = e.mediaType;
    if ((t !== 'video' && t !== 'audio') || e.kind !== 'data') return;
    // Bytes first: the sequence check below returns early when a relay omits
    // ids, and bitrate must not depend on that.
    if (e.bytes) {
      const w = byteLog[t]!;
      const now = performance.now();
      w.push([now, e.bytes]);
      while (w.length && now - w[0]![0] > BITRATE_WINDOW_MS) w.shift();
    }
    // The facade names these groupId/objectId.
    const gid = e.groupId ?? e.group, oid = e.objectId ?? e.object;
    if (gid === undefined || oid === undefined) return;
    const seq = noteSeq(objSeq, t, BigInt(gid), BigInt(oid), performance.now());
    if (seq.jump) log(`obj jump [${t}]: ${seq.jump}`);
    // One line per sweep: a multi-group gap expires every id it opened at once.
    if (seq.lost) log(`obj lost [${t}]: ${seq.lost} from ${seq.firstLostKey}`);
  };

  // Arrival and CMAF video timeline trace, at most four lines a second: an
  // arrival gap over 150 ms; a video fragment starting before the previous one
  // (dropped), ending inside video already received (overlap), or starting more
  // than two frames after the previous one (MSE drops to the next keyframe).
  let traceVideoInit: { timescale: number; trex?: TrexDefaults } | null = null;
  let tracePrev: { start: bigint; end: bigint; group: bigint } | null = null;
  let traceMaxEnd: bigint | null = null;
  /** The last video group starting 5 s or more past the previous fragment, and when it arrived. */
  let traceTimelineJump: { group: bigint; atMs: number } | null = null;
  let traceWindowMs = 0;
  let traceLines = 0;
  let traceUnlogged = 0;
  // A hidden page runs its handlers late; arrival gaps then measure the throttle.
  let traceShownAtMs = 0;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) traceShownAtMs = performance.now();
  });
  /** When the trace last saw the video input reorder or jump. */
  let traceJumpAtMs = -Infinity;
  // Holes between buffered video ranges at or ahead of the playhead, and
  // whether the trace saw the input jump or reorder just before.
  const videoHolesSeen = new Map<string, [number, number]>();
  /** Holes the playhead ran through, and their total length. */
  let videoFreezes = 0;
  let videoFrozenSec = 0;
  /** Starts of holes that are not freezes: paused intervals, and holes skipped because they could not fill. */
  const skippedHoleStartsSec: number[] = [];
  const noteSkippedHole = (startSec: number): void => {
    skippedHoleStartsSec.push(startSec);
    if (skippedHoleStartsSec.length > 8) skippedHoleStartsSec.shift();
  };
  const holeSkipped = (startSec: number): boolean =>
    skippedHoleStartsSec.some((s) => Math.abs(startSec - s) < 0.05);
  const noteVideoHoles = (ms: any): void => {
    const ranges: Array<[number, number]> | undefined = ms?.bufferedRanges?.('video');
    const video = playerContainer.querySelector('video');
    if (!ranges || !video) return;
    const t = video.currentTime;
    const holes = new Set<string>();
    for (let i = 1; i < ranges.length; i++) {
      const a = ranges[i - 1]![1];
      const b = ranges[i]![0];
      if (b < t - 1) continue;
      if (holeSkipped(a)) continue;
      const key = `${a.toFixed(2)}-${b.toFixed(2)}`;
      holes.add(key);
      if (videoHolesSeen.has(key)) continue;
      videoHolesSeen.set(key, [a, b]);
      const input = performance.now() - traceJumpAtMs < 5000
        ? 'the trace saw the input jump or reorder within 5 s'
        : 'input contiguous per trace';
      log(`MSE video hole [${a.toFixed(2)}–${b.toFixed(2)}] (${Math.round((b - a) * 1000)}ms) `
        + `at t=${t.toFixed(2)} · ${input}${describeBuffers()}`);
    }
    for (const [key, [a, b]] of videoHolesSeen) {
      if (t >= b) {
        if (!holeSkipped(a)) {
          videoFreezes++;
          videoFrozenSec += b - a;
        }
        videoHolesSeen.delete(key);
      } else if (!holes.has(key)) {
        videoHolesSeen.delete(key); // filled before playback reached it
      }
    }
  };
  const traceLog = (msg: string): void => {
    const nowMs = performance.now();
    if (nowMs - traceWindowMs >= 1000) {
      if (traceUnlogged > 0) log(`trace: ${traceUnlogged} more lines not shown`);
      traceWindowMs = nowMs;
      traceLines = 0;
      traceUnlogged = 0;
    }
    if (traceLines >= 4) {
      traceUnlogged++;
      return;
    }
    traceLines++;
    log(msg);
  };
  /** Timescale and trex defaults of a CMAF track's init segment, from the catalog. */
  const cmafInit = (cat: any, track: any): { timescale: number; trex?: TrexDefaults } | null => {
    const b64: unknown = track?.initData
      ?? (cat?.initDataList ?? []).find((d: any) => d.id === track?.initRef)?.data;
    if (typeof b64 !== 'string') return null;
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const timescale = readMdhdTimescale(bytes);
      if (!timescale) return null;
      const trex = readTrexDefaults(bytes).values().next().value;
      return trex ? { timescale, trex } : { timescale };
    } catch {
      return null;
    }
  };
  const traceArrival = (e: any, nowMs: number): void => {
    const kind = e.mediaType as 'video' | 'audio';
    const prevArrival = lastArrivalMs[kind];
    const throttled = document.hidden || nowMs - traceShownAtMs < 1000;
    if (!throttled && prevArrival !== undefined && nowMs - prevArrival > 150) {
      traceLog(`trace ${kind}: arrival gap ${Math.round(nowMs - prevArrival)}ms before group ${e.groupId}/${e.objectId}`);
    }
  };
  /** CMAF video decode steps, from the engine's event: playa's carries no payload. */
  const traceVideoTimeline = (e: any, nowMs: number): void => {
    const init = traceVideoInit;
    if (e.mediaType !== 'video' || e.kind !== 'data' || !init || !e.payload) return;
    const ranges = readSegmentTimeRanges(e.payload, init.trex);
    if (!ranges || ranges.length === 0) return;
    let start = ranges[0]!.startTime;
    let end = ranges[0]!.endTime;
    for (const r of ranges) {
      if (r.startTime < start) start = r.startTime;
      if (r.endTime > end) end = r.endTime;
    }
    const ms = (ticks: bigint): string => ((Number(ticks) * 1000) / init.timescale).toFixed(1);
    const prev = tracePrev;
    const maxEnd = traceMaxEnd;
    const group = BigInt(e.groupId);
    tracePrev = { start, end, group };
    if (maxEnd === null || end > maxEnd) traceMaxEnd = end;
    if (prev === null || maxEnd === null) return;
    const where = `group ${e.groupId}/${e.objectId}${group !== prev.group ? ' (new group)' : ''}`;
    const prevDur = `previous dur ${ms(prev.end - prev.start)}ms`;
    if (start < prev.start) {
      traceJumpAtMs = nowMs;
      traceLog(`trace video: ${where} starts ${ms(prev.start - start)}ms before the previous fragment (out of order, dropped) · dur ${ms(end - start)}ms`);
    } else if (end <= maxEnd) {
      traceLog(`trace video: ${where} ends ${ms(maxEnd - end)}ms inside video already received (overlap, appended) · dur ${ms(end - start)}ms · ${prevDur}`);
    } else if (start - prev.start > 2n * (prev.end - prev.start)) {
      traceJumpAtMs = nowMs;
      if (start - prev.end >= 5n * BigInt(init.timescale)) traceTimelineJump = { group, atMs: nowMs };
      traceLog(`trace video: ${where} starts ${ms(start - prev.end)}ms after the previous fragment's end · ${prevDur}`);
    }
  };

  (player as any).engine?.on('media_object', (e: any) => traceVideoTimeline(e, performance.now()));
  // Samples a timeline jump left behind measure stale data: every latency
  // figure drops them, including ticks already charted.
  type LatSample = [number, number, bigint | undefined];
  const dropStaleLatency = (stale: (sample: LatSample) => boolean, video: boolean): void => {
    let firstDroppedMs = Infinity;
    const drop = (win: LatSample[]): void => {
      for (let i = win.length - 1; i >= 0; i--) {
        if (!stale(win[i]!)) continue;
        firstDroppedMs = Math.min(firstDroppedMs, win[i]![0]);
        win.splice(i, 1);
      }
    };
    if (!video) { drop(audioLatWindow); return; }
    drop(latWindow);
    drop(latHistory);
    if (firstDroppedMs === Infinity) return;
    const corrected = (from: number, to: number): number[] =>
      latHistory.filter(([t]) => t > from && t <= to).map(([, v]) => v - lastDriftCorrectionMs);
    const lastTickMs = sampleAtMs.length ? sampleAtMs[sampleAtMs.length - 1]! : -Infinity;
    const pending = latWindow.filter(([t]) => t > lastTickMs).map(([, v]) => v);
    tickWorstRawMs = pending.length ? Math.max(...pending) : -Infinity;
    for (let i = sampleAtMs.length - 1; i >= 0 && sampleAtMs[i]! >= firstDroppedMs; i--) {
      const at = sampleAtMs[i]!;
      const inTick = corrected(i > 0 ? sampleAtMs[i - 1]! : -Infinity, at);
      const inWindow = corrected(at - LAT_WINDOW_MS, at);
      latTickMaxSamples[i] = inTick.length ? Math.max(...inTick) : NaN;
      latP50Samples[i] = inWindow.length ? percentile(inWindow, 0.5) : NaN;
      latP95Samples[i] = inWindow.length ? percentile(inWindow, 0.95) : NaN;
    }
  };
  /** Start of the current picture freeze (performance.now()), or null while it moves. */
  let frozenSinceMs: number | null = null;
  const freezeWatch = new FreezeWatch();
  /** Takes back the video latency samples and charted ticks since a freeze began. */
  const withdrawLatencySince = (sinceMs: number): void => {
    dropStaleLatency(([t]) => t >= sinceMs, true);
    for (let i = playoutWindow.length - 1; i >= 0; i--) {
      if (playoutWindow[i]![0] >= sinceMs) playoutWindow.splice(i, 1);
    }
    for (let i = sampleAtMs.length - 1; i >= 0 && sampleAtMs[i]! >= sinceMs; i--) {
      latP50Samples[i] = NaN;
      latP95Samples[i] = NaN;
      latTickMaxSamples[i] = NaN;
    }
  };
  /** Start of the video hole the playhead is in, or null. */
  const holeAtPlayhead = (t: number): number | null => {
    for (const [a, b] of videoHolesSeen.values()) if (t >= a && t < b && !holeSkipped(a)) return a;
    return null;
  };
  (player as any).engine?.on('timeline_jump', (e: any) => {
    log(`Timeline jump [${e.mediaType}]: group ${e.fromGroupId} → ${e.toGroupId} (+${(e.jumpMs / 1000).toFixed(1)} s)`);
    dropStaleLatency(([, , g]) => g !== undefined && g < e.toGroupId, e.mediaType === 'video');
  });
  // MSE skipped a hole that could not fill: no freeze, and on a timeline jump
  // the samples before the live group are stale.
  (player as any).engine?.on('gap_jump', (e: any) => {
    if (e.reason === 'hole') return;
    noteSkippedHole(e.holeStart);
    const jump = traceTimelineJump;
    if (e.reason !== 'timeline' || jump === null) return;
    log(`Timeline jump [cmaf]: skipped ${e.holeSec.toFixed(1)} s to group ${jump.group}`);
    dropStaleLatency(([, , g]) => g !== undefined && g < jump.group, true);
    dropStaleLatency(([t]) => t < jump.atMs, false);
  });
  // A new subscription restarts the track's ids: groups published across the
  // outage or switch were never requested, so they are not loss.
  (player as any).engine?.on('track_subscribed', (e: any) => {
    rebaseSeqs(objSeq, { dropPending: true, track: e.mediaType });
    // 'ready' precedes track selection, so the pickers are empty until now.
    fillTrackPickers();
  });
  (player as any).on('media_object', (e: any) => {
    if ((e.mediaType === 'video' || e.mediaType === 'audio') && e.kind === 'data') {
      const nowMs = performance.now();
      traceArrival(e, nowMs);
      lastArrivalMs[e.mediaType as 'video' | 'audio'] = nowMs;
    }
    noteObject(e);
    const picked = e.kind === 'data' ? pickCaptureTime(e.captureTimes) : undefined;
    if (e.kind === 'data') noteTiming(e, picked);
    const sampleGroup = e.groupId ?? e.group;
    const latGroup = sampleGroup === undefined ? undefined : BigInt(sampleGroup);
    if (e.mediaType === 'audio' && picked) {
      const audioLatencyMs = wallNowMs() - picked.us / 1000;
      if (Math.abs(audioLatencyMs) < 120_000) audioLatWindow.push([performance.now(), audioLatencyMs, latGroup]);
    }
    if (e.mediaType !== 'video' || e.kind !== 'data') return;

    const arrivalMs = performance.now();
    // Without a wall-clock source, the stamp is media time.
    const captureMs = picked ? picked.us / 1000
      : e.captureTimestamp && e.captureTimestamp > 0n ? Number(e.captureTimestamp) / 1000
      : 0;

    if (captureMs && prevCaptureMs) {
      // D = (Rj - Ri) - (Sj - Si);  J += (|D| - J) / 16
      const d = (arrivalMs - prevArrivalMs) - (captureMs - prevCaptureMs);
      jitterEwma += (Math.abs(d) - jitterEwma) / 16;
    } else if (prevArrivalMs) {
      const interval = arrivalMs - prevArrivalMs;
      if (expectedIntervalMs) jitterEwma += (Math.abs(interval - expectedIntervalMs) - jitterEwma) / 16;
      expectedIntervalMs = expectedIntervalMs
        ? expectedIntervalMs * 0.9 + interval * 0.1 : interval;
    }

    prevArrivalMs = arrivalMs;
    if (captureMs) {
      prevCaptureMs = captureMs;
      let latencyMs = wallNowMs() - captureMs;
      latencySource = picked?.source ?? null;
      relativeDelay = !picked;
      if (relativeDelay) {
        // A lower value, or a jump past any plausible delay, rebases.
        if (relativeBaseMs === null || latencyMs < relativeBaseMs || latencyMs - relativeBaseMs > 120_000) {
          relativeBaseMs = latencyMs;
        }
        latencyMs -= relativeBaseMs;
      }
      // Kept whatever the sign: a publisher stamping ahead of its own clock,
      // or an unsynchronised pair of machines, is an offset the tick removes.
      // Only a stamp too far out to be a clock difference is dropped.
      // Arrivals go on while the picture is frozen; they are not what is on screen.
      if (Math.abs(latencyMs) < 120_000 && frozenSinceMs === null) {
        const now = performance.now();
        const sample: [number, number, bigint | undefined] = [now, latencyMs, latGroup];
        latWindow.push(sample);
        latHistory.push(sample);
        if (latencyMs > tickWorstRawMs) tickWorstRawMs = latencyMs;
      }
    }
  });

  /** Backing-store size for the element. Assigning width or height reallocates
   *  and clears the canvas, so it is done only when the size changed. */
  function fitCanvas(canvas: HTMLCanvasElement): [number, number] {
    const w = Math.floor(canvas.clientWidth * devicePixelRatio);
    const h = Math.floor(canvas.clientHeight * devicePixelRatio);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return [w, h];
  }

  /** Samples further apart than this are drawn as a gap (a stalled tick); a hidden page ticks at 1 Hz. */
  const CHART_GAP_MS = 2_000;

  /** x for a time on a chart of width `w` ending at `nowMs`. */
  const chartX = (atMs: number, nowMs: number, w: number) =>
    ((atMs - (nowMs - CHART_SPAN_MS)) / CHART_SPAN_MS) * w;

  /** Trace one series against the sample times; NaN and time gaps lift the pen. */
  function traceSeries(ctx: CanvasRenderingContext2D, data: number[], nowMs: number,
                       w: number, yOf: (v: number) => number): void {
    let pen = false;
    data.forEach((v, i) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      const x = chartX(sampleAtMs[i]!, nowMs, w);
      if (pen && sampleAtMs[i]! - sampleAtMs[i - 1]! <= CHART_GAP_MS) ctx.lineTo(x, yOf(v));
      else ctx.moveTo(x, yOf(v));
      pen = true;
    });
  }

  function drawSpark(canvas: HTMLCanvasElement, nowMs: number, data: number[],
                     color: string, refLine = 0,
                     marks?: number[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const [w, h] = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const live = data.filter(Number.isFinite);
    if (live.length < 2) return;
    const max = Math.max(...live, refLine) * 1.15 || 1;
    const yOf = (v: number) => h - (v / max) * (h - 6) - 3;
    if (refLine > 0) {
      ctx.beginPath();
      ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
      ctx.moveTo(0, yOf(refLine));
      ctx.lineTo(w, yOf(refLine));
      ctx.strokeStyle = '#667';
      ctx.lineWidth = devicePixelRatio;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const m of marks ?? []) {
      ctx.fillStyle = 'rgba(204, 68, 68, 0.55)';
      ctx.fillRect(chartX(m, nowMs, w) - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    }
    ctx.beginPath();
    traceSeries(ctx, data, nowMs, w, yOf);
    ctx.strokeStyle = color;
    ctx.lineWidth = devicePixelRatio;
    ctx.stroke();
  }

  /** Two series on one scale — only comparable on a shared axis. */
  function drawSpark2(canvas: HTMLCanvasElement, nowMs: number, a: number[], aColor: string,
                      b: number[], bColor: string, refLine = 0,
                      marks?: number[], peak?: { atMs: number; value: number } | null): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const [w, h] = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1, refLine,
      ...a.filter(Number.isFinite), ...b.filter(Number.isFinite)) * 1.15;
    const yOf = (v: number) => h - (v / max) * (h - 6) - 3;
    if (refLine > 0) {
      ctx.beginPath();
      ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
      ctx.moveTo(0, yOf(refLine));
      ctx.lineTo(w, yOf(refLine));
      ctx.strokeStyle = '#667';
      ctx.lineWidth = devicePixelRatio;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const m of marks ?? []) {
      ctx.fillStyle = 'rgba(204, 68, 68, 0.55)';
      ctx.fillRect(chartX(m, nowMs, w) - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    }
    for (const [data, color] of [[a, aColor], [b, bColor]] as Array<[number[], string]>) {
      if (data.filter(Number.isFinite).length < 2) continue;
      ctx.beginPath();
      traceSeries(ctx, data, nowMs, w, yOf);
      ctx.strokeStyle = color;
      ctx.lineWidth = devicePixelRatio;
      ctx.stroke();
    }
    if (peak) {
      // Off the curves' scale, the dot is pinned to the top edge.
      const r = 2.5 * devicePixelRatio;
      ctx.beginPath();
      ctx.arc(chartX(peak.atMs, nowMs, w), Math.max(r, yOf(peak.value)), r, 0, 2 * Math.PI);
      ctx.fillStyle = '#e07a7a';
      ctx.fill();
    }
  }

  // ── Transport panel (QUIC/WebTransport) ───────────────────────────
  // Polled only while the panel is open. Chrome reports these on the
  // WebTransport object; native QUIC adapters and other browsers may not,
  // in which case the panel says so rather than showing zeros.
  let prevWtBytes = 0;
  let prevWtAtMs = 0;
  const advCell = (label: string, v: string) =>
    `<div class="cell">${label}:<b>${v}</b></div>`;
  const renderTransport = async (): Promise<void> => {
    if (!advPanel.open) return;
    const conn = (player as any).engine?.connection;
    const st = await conn?.getTransportStats?.();
    if (!st) {
      advGrid.innerHTML = advCell('transport stats',
        conn ? 'not reported by this transport' : 'not connected');
      return;
    }
    const num = (k: string): number | undefined => st[k];
    const ms = (k: string) => (num(k) != null ? `${num(k)!.toFixed(1)} ms` : '—');
    const lost = num('packetsLost') ?? 0;
    const rcvd = num('packetsReceived') ?? 0;
    const lossPct = rcvd + lost > 0 ? (lost / (rcvd + lost)) * 100 : 0;
    const bytes = num('bytesReceived') ?? 0;
    const nowMs = performance.now();
    // Wire goodput, which includes every stream and MOQT overhead — not the
    // media bitrate the catalog advertises.
    const goodputMbps = prevWtAtMs && bytes > prevWtBytes
      ? ((bytes - prevWtBytes) * 8) / ((nowMs - prevWtAtMs) * 1000)
      : 0;
    prevWtBytes = bytes; prevWtAtMs = nowMs;
    const cells = [
      advCell('rtt smoothed', ms('smoothedRtt')),
      advCell('rtt min', ms('minRtt')),
      advCell('rtt variation', ms('rttVariation')),
      advCell('packets lost', `${lost} (${lossPct.toFixed(2)}%)`),
      advCell('packets rx / tx', `${rcvd} / ${num('packetsSent') ?? 0}`),
      advCell('bytes rx', `${(bytes / 1e6).toFixed(1)} MB`),
      advCell('goodput', `${goodputMbps.toFixed(2)} Mbps`),
      advCell('est send rate', num('estimatedSendRate') != null
        ? `${(num('estimatedSendRate')! / 1e6).toFixed(2)} Mbps` : '—'),
      advCell('streams in / out',
        `${num('numIncomingStreamsCreated') ?? 0} / ${num('numOutgoingStreamsCreated') ?? 0}`),
    ];
    // Datagram counters only exist once a datagram has moved.
    for (const k of Object.keys(st)) {
      if (k.startsWith('datagrams.')) cells.push(advCell(k.slice(10), String(st[k])));
    }
    advGrid.innerHTML = cells.join('');
  };
  advPanel.addEventListener('toggle', () => { void renderTransport(); });

  let advTick = 0;
  setInterval(() => {
    watchVideo();
    if (++advTick % 4 === 0) void renderTransport();
    // The MSE adapter exists only after the catalog. Its recovery reports are
    // informational slots the engine leaves to the app.
    const ms = (player as any).engine?.mediaSource;
    if (ms && ms.onPlayheadAdjust === null) {
      ms.onPlayheadAdjust = (kind: string, from: number, to: number) =>
        log(`[MSE] ${kind === 'nudge' ? 'stall nudge' : 'post-stall snap to live edge'} `
          + `${from.toFixed(2)} → ${to.toFixed(2)}`);
      ms.onWedge = (info: { rung: number; currentTime: number; readyState: number; bufferedRanges: string }) =>
        log(`[MSE] playhead wedged (rung ${info.rung}) at t=${info.currentTime.toFixed(2)} `
          + `rs=${info.readyState} buffered=${info.bufferedRanges}${describeBuffers()}`);
      ms.onLiveEdgeResync = (reason: string) => log(`[MSE] live-edge resync (${reason})`);
      ms.onChaseFloor = (floorSec: number, aheadSec: number) =>
        log(`[MSE] stalled with ${Math.round(aheadSec * 1000)}ms buffered while catching up; `
          + `catch-up now stops at ${Math.round(floorSec * 1000)}ms`);
    }
    if (debug && ms && ms.debug === false) ms.debug = true;
    // Per-track depth ahead of the playhead: MSE SourceBuffers on CMAF; on LOC
    // the render queue and the audio scheduled in WebAudio.
    const tickNowMs = performance.now();
    renderStatusBadges(tickNowMs);
    const eng = (player as any).engine;
    noteVideoHoles(eng?.mediaSource);
    const byKind = eng?.mediaSource?.getBufferAheadMsByKind?.();
    const renderer = (player as any).renderer;
    if (renderer && renderer.onFrameDrawn === null) renderer.onFrameDrawn = noteFrameDrawn;
    // An empty render queue is 0 ms ahead, not a missing sample.
    const vMs = byKind ? byKind.video
      : renderer ? (renderer.queuedAheadMs ?? 0) : null;
    const aMs = byKind ? byKind.audio
      : (((player as any).audioOutput?.scheduledAheadSec ?? null) != null
        ? (player as any).audioOutput.scheduledAheadSec * 1000 : null);
    // A hidden page ticks at 1 Hz or slower. Queue depths and the drift fit would
    // measure that throttle, so they skip it; latency and jitter come from arrivals.
    const hidden = document.hidden;

    // The playhead is watched on MSE only, while it should be moving.
    const engStats = eng?.stats;
    const videoEl = byKind ? playerContainer.querySelector('video') : null;
    const watchPlayhead = videoEl !== null && !hidden && player.state === 'playing'
      && engStats?.timeToFirstFrameMs != null;
    const freezeSince = freezeWatch.update({
      nowMs: tickNowMs,
      ongoingStallMs: engStats?.ongoingStallMs ?? 0,
      playheadSec: watchPlayhead ? videoEl.currentTime : null,
      playbackRate: videoEl?.playbackRate ?? 1,
      holeStartSec: watchPlayhead ? holeAtPlayhead(videoEl.currentTime) : null,
    });
    if (freezeSince !== null && (frozenSinceMs === null || freezeSince < frozenSinceMs)) {
      withdrawLatencySince(freezeSince);
    }
    frozenSinceMs = freezeSince;
    const frozen = frozenSinceMs !== null;

    // Trimmed here, not on arrival, so an outage empties the window and leaves a gap.
    while (latWindow.length && tickNowMs - latWindow[0]![0] > LAT_WINDOW_MS) latWindow.shift();
    while (latHistory.length && tickNowMs - latHistory[0]![0] > CHART_SPAN_MS + LAT_WINDOW_MS) latHistory.shift();
    const latRaw = latWindow.map(([, v]) => v);
    // Remove the clock divergence. The constant offset stays: one-way delay
    // cannot separate it from transit.
    if (!hidden && latRaw.length) clockDrift.addSample(tickNowMs, Math.min(...latRaw));
    const drift = clockDrift.estimate(tickNowMs);
    clockDriftMsPerMin = drift?.msPerMin ?? null;
    clockDriftApplied = drift?.applied ?? false;
    const driftCorrectionMs = drift?.correctionMs ?? 0;
    lastDriftCorrectionMs = driftCorrectionMs;
    const latVals = driftCorrectionMs
      ? latRaw.map((v) => v - driftCorrectionMs) : latRaw;
    while (audioLatWindow.length && tickNowMs - audioLatWindow[0]![0] > LAT_WINDOW_MS) audioLatWindow.shift();
    const audioLat = audioLatWindow.map(([, v]) => v - driftCorrectionMs);
    audioLatPct = audioLat.length
      ? [percentile(audioLat, 0.5), percentile(audioLat, 0.95), percentile(audioLat, 0.99)] : null;
    // MSE plays behind its buffered end, so on screen is roughly arrival plus that buffer.
    // The buffered-ahead term is a sawtooth between appends: report its p50
    // over the chart's window, as the drawn-frame E2E is on LOC.
    if (byKind && latVals.length && !frozen) playoutWindow.push([tickNowMs, percentile(latVals, 0.5) + byKind.video]);
    while (playoutWindow.length && tickNowMs - playoutWindow[0]![0] > LAT_WINDOW_MS) playoutWindow.shift();
    cmafPlayoutMs = playoutWindow.length ? percentile(playoutWindow.map(([, v]) => v), 0.5) : null;
    while (screenWindow.length && tickNowMs - screenWindow[0]![0] > LAT_WINDOW_MS) screenWindow.shift();
    const screenVals = screenWindow.map(([, v]) => v - driftCorrectionMs);
    // Every series takes a value on every tick, NaN where there is nothing to
    // report, so all of them index the same sample times.
    const have = latVals.length > 0 && !frozen;
    const queued = player.state !== 'idle' && !hidden;
    sampleAtMs.push(tickNowMs);
    latP50Samples.push(have ? percentile(latVals, 0.5) : NaN);
    latP95Samples.push(have ? percentile(latVals, 0.95) : NaN);
    latTickMaxSamples.push(Number.isFinite(tickWorstRawMs) && !frozen ? tickWorstRawMs - driftCorrectionMs : NaN);
    jitSamples.push(prevCaptureMs || expectedIntervalMs ? jitterEwma : NaN);
    queuedASamples.push(queued ? (aMs ?? NaN) : NaN);
    queuedVSamples.push(queued ? (vMs ?? NaN) : NaN);
    tickWorstRawMs = -Infinity;
    trimSamples(tickNowMs);

    const peakMs = maxFinite(latTickMaxSamples);
    const peakAt = peakMs === null ? -1 : latTickMaxSamples.indexOf(peakMs);
    drawSpark2(latSpark, tickNowMs, latP50Samples, '#d9c25c', latP95Samples, '#d9922e', 0, undefined,
      peakAt >= 0 ? { atMs: sampleAtMs[peakAt]!, value: peakMs! } : null);
    drawSpark(jitSpark, tickNowMs, jitSamples, '#d9922e');
    drawSpark2(cusSpark, tickNowMs, queuedASamples, '#6cf', queuedVSamples, '#a98cf0',
               targetLatencyMs, stallMarks);
    cusAVal.textContent = aMs != null ? aMs.toFixed(0) : '—';
    cusVVal.textContent = vMs != null ? vMs.toFixed(0) : '—';
    // a − v, following the order the pair is printed in.
    cusDVal.textContent = (vMs != null && aMs != null)
      ? `${aMs - vMs >= 0 ? '+' : ''}${(aMs - vMs).toFixed(0)}` : '—';
    cusTarget.textContent = targetLatencyMs ? String(targetLatencyMs) : '—';
    // One measurement (queued) against one setting (target). The render
    // cushion is a third name for the same region and pub_media pins it equal
    // to the target anyway, so it is not shown; rate and chase state are.
    const rateNow = (playerContainer.querySelector('video')?.playbackRate ?? 1);
    const audioOut = (player as any).audioOutput;
    if (audioOut && audioOut.onUnderrun === null) audioOut.onUnderrun = noteUnderrun;
    const stale = (player as any).engine?.staleVideoDrops;
    if (stale && stale.count !== staleDropsReported && tickNowMs - staleDropsReportedAtMs >= 1_000) {
      log(`Stale video dropped before MSE: ${stale.count - staleDropsReported} object(s), `
        + `latest group ${stale.group} below floor ${stale.floor} · total ${stale.count}`);
      staleDropsReported = stale.count;
      staleDropsReportedAtMs = tickNowMs;
    }
    if (tickNowMs - underrunReportAtMs >= UNDERRUN_REPORT_MS) {
      underrunReportAtMs = tickNowMs;
      reportCompat();
      const order = audioOrderNote();
      const anyRepair = orderStats().some(([, o]) => o.restored + o.missing + o.late > 0);
      if (order && order !== audioOrderReported && anyRepair) {
        audioOrderReported = order;
        log(`CMAF${order}`);
      }
      const u = underrunWindow;
      if (u.count > 0) {
        const lagNow = Math.max(0, ...lagSamples.map(([, d]) => d));
        const pct = audioLatPct ? audioLatPct.map((v) => v.toFixed(0)).join('/') : '—';
        log(`Audio underruns in ${UNDERRUN_REPORT_MS / 1000}s: ${u.count}, `
          + `${(u.gapSec * 1000).toFixed(0)} ms silent · ${u.late} late `
          + `(worst ${(u.worstLateSec * 1000).toFixed(0)} ms past its slot) · `
          + `${u.onTime} on time after missing audio · `
          + `audio arrival p50/p95/p99 ${pct} ms · lag ${lagNow.toFixed(0)} ms`);
      }
      underrunWindow = emptyUnderrunWindow();
    }
    // Own strings only — no remote input reaches this, so markup is safe here.
    // One label for one concept: playout sped up to shed latency. CMAF does it
    // with the video element's playbackRate, LOC inside WebAudioOutput where
    // there is none to read — the value carries the difference, not the name.
    const chaseRate = audioOut ? (audioOut.chasing ? 1.02 : 1) : rateNow;
    cusCushion.innerHTML = audioOut || rateNow !== 1
      ? `rate: <b${chaseRate > 1 ? '' : ' class="idle"'}>${chaseRate.toFixed(2)}x</b>`
      : '';

    // The chase acts on `lead`, which the panel cannot see; the queue also holds
    // the cushion and output buffering, so it alone is no contradiction. Log a
    // lead above the target with the chase idle, or a large queue with no lead
    // at all (alignedTime null: no chase or snap could have run).
    if (audioOut && targetLatencyMs > 0) {
      const qMs = audioOut.scheduledAheadSec * 1000;
      const leadSec = audioOut.captureLeadSec;
      const contradiction = leadSec === null
        ? qMs > targetLatencyMs * 2 : leadSec * 1000 > targetLatencyMs;
      if (contradiction && !audioOut.chasing && tickNowMs - lastChaseNoteMs > 5_000) {
        lastChaseNoteMs = tickNowMs;
        const lagNow = Math.max(0, ...lagSamples.map(([, d]) => d));
        log(`chase idle: queued=${qMs.toFixed(0)}ms target=${targetLatencyMs}ms `
          + `lead=${leadSec == null ? 'null' : (leadSec * 1000).toFixed(0) + 'ms'} `
          + `lag=${lagNow.toFixed(0)}ms snaps=${audioOut.liveEdgeSnapCount ?? 0}`);
      }
    }

    // Nothing is on screen to be late: a figure here would describe arrivals only.
    const STALLED = 'stalled';
    latVal.textContent = frozen ? STALLED : latVals.length ? percentile(latVals, 0.5).toFixed(0) : '—';
    latP95.textContent = frozen ? STALLED : latVals.length ? percentile(latVals, 0.95).toFixed(0) : '—';
    const clockOffset = referenceClock.offset;
    latKind.textContent = relativeDelay ? 'relative delay' : 'latency';
    latScreen.textContent = frozen ? STALLED : relativeDelay ? '—'
      : screenVals.length ? percentile(screenVals, 0.5).toFixed(0)
      : cmafPlayoutMs != null ? `≈${cmafPlayoutMs.toFixed(0)}` : '—';
    latMax.textContent = frozen ? STALLED : peakMs?.toFixed(0) ?? '—';
    // Drift details ride the label's hover; an empty title falls back to the chart's.
    latLabel.title = relativeDelay
      ? 'The stream carries media time, not a capture clock: delay above the lowest seen.'
      : [latencySource ? SOURCE_TIP[latencySource] : '',
        clockOffset
          ? `Clock: ${(clockOffset.offsetMs >= 0 ? '+' : '') + clockOffset.offsetMs.toFixed(0)} ms against `
            + `${new URL(clockUrl).host}, ±${(clockOffset.rttMs / 2).toFixed(0)} ms; applied to latency and E2E.`
          : 'No clock reference answered: this machine\'s clock, uncorrected.',
        clockDriftMsPerMin !== null
        ? `Clock drift ${clockDriftMsPerMin.toFixed(1)} ms/min; `
          + (clockDriftApplied ? `${driftCorrectionMs.toFixed(0)} ms removed. Constant offset remains.`
            : 'not applied until it holds steadily across the window.')
        : ''].filter(Boolean).join(' ');
    jitVal.textContent = lastFinite(jitSamples)?.toFixed(1) ?? '—';
  }, TICK_MS);

  // ── CMSF / MSF catalog panel ──────────────────────────────────────
  // Redrawn only on catalog events (initial + deltas), never per frame.
  // Catalog values are remote input: built as text nodes, never HTML.

  /** Audio, then video, then anything else in the order it arrived. */
  const trackRank = (role: unknown): number =>
    role === 'audio' ? 0 : role === 'video' ? 1 : 2;

  /** CMSF when any track is CMAF or LOCMAF, else MSF, with the catalog's version. */
  const catalogLabel = (packagings: unknown[], version: unknown): string => {
    const format = packagings.some((p) => p === 'cmaf' || p === 'locmaf') ? 'CMSF' : 'MSF';
    const v = String(version ?? '?');
    return `${format} ${v.startsWith('draft-') ? v : `v${v}`}`;
  };

  // Audio delivery shown on its catalog line while audio objects arrive as datagrams.
  let audioViaDatagrams = false;
  let datagramAudioSeen = 0;
  let datagramAudioAtMs = -Infinity;
  const audioDetail = (base: string): string => (audioViaDatagrams ? `${base} · datagrams` : base);
  function noteAudioDatagrams(): void {
    const count: number = (player as any).engine?.datagramObjects?.audio ?? 0;
    const nowMs = performance.now();
    if (count > datagramAudioSeen) {
      datagramAudioSeen = count;
      datagramAudioAtMs = nowMs;
    }
    const via = nowMs - datagramAudioAtMs < 3_000;
    if (via === audioViaDatagrams) return;
    audioViaDatagrams = via;
    const dt = catTracks.querySelector<HTMLElement>('.cat-track.audio .dt');
    if (dt?.dataset['base'] !== undefined) dt.textContent = audioDetail(dt.dataset['base']);
  }

  function renderCatalog(cat: any): void {
    const tracks: any[] = cat?.tracks ?? [];
    const videoTrack = tracks.find((t) => (t.role ?? t.name) === 'video');
    traceVideoInit = videoTrack?.packaging === 'cmaf' ? cmafInit(cat, videoTrack) : null;
    tracePrev = null;
    traceMaxEnd = null;
    audioCodec = tracks.find((t) => (t.role ?? t.name) === 'audio')?.codec ?? null;
    // Absent on the --ts path: the live demuxer has no framerate to declare.
    videoFps = Number(videoTrack?.framerate) || null;
    // The engine runs at the URL override when one is given.
    targetLatencyMs = targetLatencyOverrideMs ?? Math.max(0,
      ...tracks.map((t) => Number(t.targetLatency) || 0));
    // Same header as the broadcaster's catalog panel.
    catMeta.textContent = catalogLabel(tracks.map((t) => t.packaging), cat?.version);

    // Display order only; the catalog keeps its published order.
    const ordered = [...tracks].sort((a, b) => trackRank(a.role ?? a.name) - trackRank(b.role ?? b.name));
    catTracks.replaceChildren(...ordered.map((t) => {
      const row = document.createElement('div');
      // Whitelisted: remote input must not reach the class attribute.
      const role = (t.role ?? t.name) === 'video' ? ' video'
        : (t.role ?? t.name) === 'audio' ? ' audio' : '';
      row.className = `cat-track${role}`;
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = `${t.name ?? '(unnamed)'}:`;
      // Remote input: a text node, never markup.
      const detail = document.createElement('span');
      detail.className = 'dt';
      detail.textContent = [
        t.codec,
        t.width && t.height ? `${t.width}×${t.height}` : '',
        // 24000/1001 arrives as 23.976043701171875; three places is the most
        // that distinguishes real rates.
        t.framerate ? `${Number(Number(t.framerate).toFixed(3))}fps` : '',
        t.samplerate ? `${t.samplerate}Hz` : '',
        t.channelConfig ? `${t.channelConfig}ch` : '',
        t.bitrate ? `${Math.round(t.bitrate / 1000)}kbps` : '',
        t.initRef ? `init=${t.initRef}` : '',
      ].filter(Boolean).join(' · ');
      if (role === ' audio') {
        detail.dataset['base'] = detail.textContent;
        detail.textContent = audioDetail(detail.textContent);
      }
      const badge = document.createElement('span');
      badge.className = 'badge idle';
      badge.dataset['track'] = String(t.name ?? '');
      badge.textContent = 'FWD --';
      row.append(name, detail, badge);
      return row;
    }));

    parsedCatalog = cat;
    showCatalogJson();
  }

  // The pane shows the last full catalog as received, values untouched and
  // fields in display order; "parsed" shows the engine's catalog with deltas applied.
  let parsedCatalog: unknown = null;
  let receivedCatalog: string | null = null;
  let deltasSinceReceived = 0;
  let showParsed = false;
  function showCatalogJson(): void {
    const received = !showParsed && receivedCatalog !== null;
    catJson.textContent = received
      ? receivedCatalog
      : JSON.stringify(orderCatalogForDisplay(parsedCatalog), null, 2);
    const deltas = deltasSinceReceived === 0 ? ''
      : ` +${deltasSinceReceived} delta${deltasSinceReceived > 1 ? 's' : ''}`;
    catView.textContent = received ? `received${deltas}` : 'parsed';
    catView.title = received
      ? 'The catalog as received; click for the parsed catalog'
      : 'The parsed catalog; click for the catalog as received';
  }
  /** A full catalog replaces the received view; a delta is counted against it. */
  function noteReceivedCatalog(text: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      receivedCatalog = text;
      deltasSinceReceived = 0;
      return;
    }
    const full = typeof obj === 'object' && obj !== null && !Array.isArray(obj)
      && 'version' in obj && (obj as { deltaUpdate?: unknown }).deltaUpdate !== true;
    if (full) {
      receivedCatalog = JSON.stringify(orderCatalogForDisplay(obj), null, 2);
      deltasSinceReceived = 0;
    } else {
      deltasSinceReceived++;
    }
  }
  catView.addEventListener('click', () => {
    showParsed = !showParsed;
    showCatalogJson();
  });

  // Periodic catalog refreshes repeat an unchanged catalog; logging each one
  // buries the stall lines. Log and redraw only on a real change.
  let lastCatalogKey = '';
  const catalogKey = (cat: any): string => JSON.stringify({ ...cat, generatedAt: undefined });
  player.on('catalog_received', ({ catalog }) => {
    catalogArrived = true;
    lastCatalogKey = catalogKey(catalog);
    log(`Catalog received: ${catalog?.tracks?.length ?? 0} track(s)`);
    renderCatalog(catalog);
  });
  player.on('catalog_updated', ({ catalog }) => {
    const key = catalogKey(catalog);
    if (key === lastCatalogKey) return;
    lastCatalogKey = key;
    log('Catalog changed');
    renderCatalog(catalog);
  });
  // Size goes in the header; `?debug=1` also logs each object's head.
  let rawSeen = 0;
  player.on('catalog_raw', ({ bytes, text }) => {
    rawSeen++;
    catSize.textContent = ` · ${bytes}B`;
    // Empty text: the bytes were not UTF-8.
    if (text) {
      noteReceivedCatalog(text);
      showCatalogJson();
    }
    if (!debug) return;
    const head = text === null ? '(not UTF-8)' : text.slice(0, 120);
    log(`Catalog raw #${rawSeen}: ${bytes}B ${head}`);
  });

  const setCatalogHidden = (hidden: boolean): void => {
    layoutEl.classList.toggle('cat-hidden', hidden);
    catRestore.hidden = !hidden;
  };
  catRestore.addEventListener('click', () => setCatalogHidden(false));
  wireCopy(logCopy, () => logEl.textContent ?? '');
  wireCopy(catCopy, () => catJson.textContent ?? '');
  catToggle.addEventListener('click', () => {
    setCatalogHidden(true);
  });

  // ── Controls ──────────────────────────────────────────────────────

  playBtn.addEventListener('click', () => {
    if (player.state === 'playing') player.pause();
    else player.play();
  });

  let pausedByUser = false;
  player.on('play', () => {
    playBtn.textContent = 'Pause';
    if (!pausedByUser) return;
    pausedByUser = false;
    // Delivery stops while paused: neither the skipped ids nor the buffered hole is loss.
    rebaseSeqs(objSeq, { dropPending: false });
    const ranges: Array<[number, number]> | undefined =
      (player as any).engine?.mediaSource?.bufferedRanges?.('video');
    if (ranges?.length) noteSkippedHole(ranges[ranges.length - 1]![1]);
  });
  player.on('pause', () => {
    playBtn.textContent = 'Play';
    pausedByUser = true;
  });

  seekBar.addEventListener('input', () => player.seek(Number(seekBar.value)));
  volumeBar.addEventListener('input', () => player.setVolume(Number(volumeBar.value) / 100));
  muteBtn.addEventListener('click', () => player.toggleMute());
  player.on('volumechange', ({ muted }) => { muteBtn.textContent = muted ? 'Unmute' : 'Mute'; });

  qualitySelect.addEventListener('change', () => {
    const val = qualitySelect.value;
    void player.setQuality(val === 'auto' ? 'auto' : Number(val))
      .catch((err: unknown) => log(`Quality switch failed: ${(err as Error).message}`));
  });
  // A switch commits at the new track's next group; a refused one is rolled back.
  const switchFrom = (sel: HTMLSelectElement, what: string, run: () => Promise<void>): void => {
    sel.addEventListener('change', () => {
      void run().catch((err: unknown) => {
        log(`${what} switch failed: ${(err as Error).message}`);
        fillTrackPickers();
      });
    });
  };
  switchFrom(programSelect, 'Program', () => player.selectProgram(Number(programSelect.value)));
  switchFrom(viewSelect, 'View', () => player.selectView(Number(viewSelect.value)));
  switchFrom(langSelect, 'Audio', () => player.selectAudioTrack(langSelect.value));

  // ── Load ──────────────────────────────────────────────────────────

  log(`Relay: ${relayUrl}`);
  log(`Namespace: ${namespace}`);
  setText('conn-relay', relayUrl);
  setText('conn-ns', namespace);
  for (const id of ['conn-relay', 'conn-ns']) {
    const el = document.getElementById(id);
    if (el) copyOnClick(el);
  }
  setText('conn-draft', draftVersion === undefined ? 'auto' : String(draftVersion));
  setupBadgeState = { tone: 'wait', detail: `SETUP to ${relayUrl}; awaiting the relay` };
  // Closing, reloading or navigating away ends the session now instead of at the
  // relay's idle timeout. A page kept in the back/forward cache stays connected.
  window.addEventListener('pagehide', (e) => {
    if (e.persisted) return;
    void (player as any).engine?.connection?.close().catch(() => { /* already closed */ });
  });
  player.load().catch((err) => log(`Fatal: ${(err as Error).message}`));
}

void main();
