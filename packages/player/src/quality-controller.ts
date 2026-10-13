/**
 * QualityController — ABR track selection using @moqt/msf APIs.
 *
 * Selects initial video and audio tracks from the catalog.
 * Responds to `reduce_quality` recovery actions by stepping down
 * through the altGroup (lower bitrate alternatives).
 *
 * Catalog model (shared with the FFmpeg and OBS publishers):
 * - a renderGroup is a program — tracks meant to be rendered together;
 *   tracks without one belong to every program;
 * - each video altGroup is a view of its program, and ABR runs inside it;
 * - audio languages share an altGroup and are told apart by `lang`.
 *
 * renderGroup does NOT imply time alignment (moq-wg/msf#142), so a switch
 * between views or programs cannot assume their groups line up.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 * @see draft-ietf-moq-msf-00 §4.2 (time-alignment)
 * @see draft-ietf-moq-msf-00 §5.1.18 (renderGroup)
 * @module
 */

import type { CatalogTrack, CatalogState, TrackConstraints } from '@moqt/msf';
import { groupByAlt, selectTrack, isTrackPackagingSupported } from '@moqt/msf';
import type { ClockSource } from '@moqt/playback';

/** Configuration for the quality controller. */
export interface QualityControllerConfig {
  /** Enable automatic quality selection. Default: true. */
  readonly autoQuality: boolean;
  /** Initial quality level. Default: 'auto'. */
  readonly startLevel: number | 'lowest' | 'auto';
  /** Maximum resolution cap. */
  readonly capLevelToResolution?: { readonly width: number; readonly height: number };
  /** Minimum time between quality switches. Default: 5000. */
  readonly qualitySwitchCooldownMs: number;
  /** Clock for cooldown tracking. */
  readonly clock: ClockSource;
  /**
   * altGroup of the view to start on when the catalog has several views.
   * Falls back to the first view in catalog order when absent or unknown.
   */
  readonly initialView?: number;
  /**
   * renderGroup of the program to start on when the catalog has several.
   * `initialView` wins when it names a view of another program. Default: the
   * program of the first video track in catalog order.
   */
  readonly initialProgram?: number;
  /**
   * Preferred audio language (BCP-47 or ISO 639; matched on the primary
   * subtag, ignoring case). Never filters the audio choice down to nothing.
   */
  readonly preferredLanguage?: string;
}

/**
 * One program: the tracks of a renderGroup, meant to be rendered together.
 * Tracks without a renderGroup are shared by every program.
 *
 * @see draft-ietf-moq-msf-00 §5.1.18 (renderGroup)
 */
export interface CatalogProgram {
  readonly renderGroup: number;
  /** Tracks of the program, shared ones included, in catalog order. */
  readonly tracks: readonly CatalogTrack[];
}

/**
 * One video view: an altGroup of the catalog.
 *
 * Distinct altGroups carry different content (e.g. a landscape and a
 * portrait canvas); the tracks inside one altGroup are quality
 * alternatives of that content, so ABR runs inside the current view only.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 */
export interface VideoView {
  readonly altGroup: number;
  /** Program the view belongs to; undefined when shared by every program. */
  readonly renderGroup: number | undefined;
  /** Usable tracks of the view, sorted by bitrate descending. */
  readonly tracks: readonly CatalogTrack[];
}

/** Selection constraints for initial track selection. */
export interface SelectionConstraints {
  readonly videoConstraints?: TrackConstraints;
  readonly audioConstraints?: TrackConstraints;
  readonly disableVideo?: boolean;
  readonly disableAudio?: boolean;
}

/** Result of initial track selection. */
export interface SelectedTracks {
  readonly video: CatalogTrack | undefined;
  readonly audio: CatalogTrack | undefined;
}

/**
 * Manages track quality selection and ABR step-down.
 */
export class QualityController {
  private autoQuality: boolean;
  private readonly startLevel: number | 'lowest' | 'auto';
  private readonly capLevelToResolution: { readonly width: number; readonly height: number } | undefined;
  private readonly qualitySwitchCooldownMs: number;
  private readonly clock: ClockSource;
  private readonly initialView: number | undefined;
  private readonly initialProgram: number | undefined;
  /**
   * Language to prefer when a program switch picks audio: the configured
   * preference, replaced by the viewer's last explicit language choice.
   */
  private preferredLanguage: string | undefined;

  /** Subscribable tracks of the catalog, in catalog order. */
  private usableTracks: CatalogTrack[] = [];
  /** Programs (renderGroups) of the catalog, in catalog order. Empty without renderGroups. */
  private programList: CatalogProgram[] = [];
  /** renderGroup of the current program; undefined without renderGroups. */
  private _currentProgram: number | undefined;
  /** Every video view of the catalog, all programs, in catalog order. */
  private allViews: VideoView[] = [];
  /** The view the alternatives below belong to. */
  private currentViewEntry: VideoView | undefined;

  /** ABR-switchable alternatives — same codec family, sorted by bitrate (highest first). */
  private videoAlternatives: CatalogTrack[] = [];
  /** ALL video alternatives including cross-codec (for manual selection UI). */
  private allVideoAlternatives: CatalogTrack[] = [];

  /** Current index into videoAlternatives. */
  private videoIndex = 0;

  /** Selected audio track. */
  private _audioTrack: CatalogTrack | undefined;

  /** Timestamp of last quality switch for cooldown enforcement. Undefined = never switched. */
  private lastSwitchTimeUs: number | undefined;

  constructor(config?: QualityControllerConfig) {
    this.autoQuality = config?.autoQuality ?? true;
    this.startLevel = config?.startLevel ?? 'auto';
    this.capLevelToResolution = config?.capLevelToResolution;
    this.qualitySwitchCooldownMs = config?.qualitySwitchCooldownMs ?? 0;
    this.clock = config?.clock ?? { now: () => performance.now() * 1000 };
    this.initialView = config?.initialView;
    this.initialProgram = config?.initialProgram;
    this.preferredLanguage = config?.preferredLanguage;
  }

  /** Current video track. */
  get currentVideoTrack(): CatalogTrack | undefined {
    return this.videoAlternatives[this.videoIndex];
  }

  /** Current audio track. */
  get currentAudioTrack(): CatalogTrack | undefined {
    return this._audioTrack;
  }

  /**
   * Select initial tracks from a catalog.
   *
   * Video: picks from altGroup alternatives using constraints.
   * Audio: picks the best matching audio track.
   *
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup for video)
   */
  selectInitialTracks(
    catalog: CatalogState,
    constraints?: SelectionConstraints,
  ): SelectedTracks {
    // LOCMAF §5: a receiver MUST NOT subscribe to a locmafVersion it does not
    // support — exclude those tracks so an alternative packaging is chosen.
    const usable = catalog.tracks.filter(isTrackPackagingSupported);

    this.usableTracks = usable;
    this.programList = programsOf(usable);
    this.allViews = viewsOf(usable.filter(t => t.role === 'video'));
    this._currentProgram = this.initialProgramOf(usable);

    // Only the current program's tracks (plus shared ones) are candidates.
    const scoped = usable.filter(t => inProgram(t, this._currentProgram));
    const videoTracks = scoped.filter(t => t.role === 'video');
    const audioTracks = this.audioTracks;

    // Each altGroup is a view; ABR alternatives come from one view only.
    const views = this.views;
    let viewTracks: readonly CatalogTrack[];
    if (views.length > 0) {
      const view = views.find(v => v.altGroup === this.initialView) ?? views[0]!;
      this.currentViewEntry = view;
      viewTracks = view.tracks;
    } else {
      // No altGroup — treat all video tracks as alternatives
      this.currentViewEntry = undefined;
      viewTracks = videoTracks;
    }

    const videoAlts = this.cappedAlternatives(viewTracks);

    // Store ALL alternatives (for availableVideoTracks / manual selection)
    this.allVideoAlternatives = videoAlts;

    // Select based on startLevel
    let video: CatalogTrack | undefined;
    if (this.startLevel === 'lowest') {
      video = videoAlts[videoAlts.length - 1];
    } else if (typeof this.startLevel === 'number') {
      // Clamp to valid range
      const idx = Math.min(this.startLevel, videoAlts.length - 1);
      video = videoAlts[idx];
    } else {
      // 'auto' — use constraints or pick middle of ladder. Starting at
      // the highest bitrate is catastrophic on constrained networks
      // (conference WiFi, cellular) — the player stalls before the
      // recovery controller can downshift. Middle is safe: one
      // downshift reaches low quality, one upshift reaches high.
      video = constraints?.videoConstraints
        ? selectTrack(videoAlts, constraints.videoConstraints)
        : videoAlts[Math.floor(videoAlts.length / 2)];
    }

    // Narrow ABR alternatives to the selected track's codec family.
    // Cross-codec switches (AVC↔HEVC) require changeType/reconfigure
    // and interleave different codecs at similar bitrates — ABR would
    // bounce between codecs instead of stepping down in quality.
    // Manual selection (selectVideoTrack) can still cross codecs.
    this.videoAlternatives = sameCodecFamily(videoAlts, video);

    // Set videoIndex to match selected track in the narrowed list
    this.videoIndex = video ? this.videoAlternatives.indexOf(video) : 0;
    if (this.videoIndex === -1) this.videoIndex = 0;

    // Select audio: preferred language first, then constraints, then catalog order
    const languages = matchingLanguage(audioTracks, this.preferredLanguage);
    const audio = constraints?.audioConstraints
      ? selectTrack(languages, constraints.audioConstraints) ?? selectTrack(audioTracks, constraints.audioConstraints)
      : languages[0];
    this._audioTrack = audio;

    return {
      video: constraints?.disableVideo ? undefined : video,
      audio: constraints?.disableAudio ? undefined : audio,
    };
  }

  /**
   * Reduce video quality by one step (next-lower bitrate in altGroup).
   *
   * Returns null if:
   * - Already at the lowest quality
   * - autoQuality is disabled
   * - Cooldown period hasn't elapsed
   *
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup alternatives)
   * @see draft-ietf-moq-msf-00 §4.2 (switch at group boundaries)
   */
  reduceVideoQuality(emergency = false): CatalogTrack | null {
    if (!this.autoQuality) return null;

    // Enforce cooldown (bypassed for emergency downshifts)
    if (!emergency) {
      const now = this.clock.now();
      const cooldownUs = this.qualitySwitchCooldownMs * 1000;
      if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
        return null;
      }
    }

    if (this.videoIndex >= this.videoAlternatives.length - 1) {
      return null; // Already at lowest
    }
    this.videoIndex++;
    this.lastSwitchTimeUs = this.clock.now();
    return this.videoAlternatives[this.videoIndex] ?? null;
  }

  /**
   * Increase video quality by one step (next-higher bitrate in altGroup).
   * Returns the new track, or null if already at highest or blocked by
   * cooldown / autoQuality=false.
   */
  increaseVideoQuality(): CatalogTrack | null {
    if (!this.autoQuality) return null;

    const now = this.clock.now();
    const cooldownUs = this.qualitySwitchCooldownMs * 1000;
    if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
      return null;
    }

    if (this.videoIndex <= 0) {
      return null; // Already at highest
    }
    this.videoIndex--;
    this.lastSwitchTimeUs = now;
    return this.videoAlternatives[this.videoIndex] ?? null;
  }

  // ─── Non-mutating helpers for deferred commit ──────────────────

  /**
   * Peek at the next lower quality track WITHOUT mutating state.
   * Returns null if blocked by cooldown, autoQuality, or already at lowest.
   */
  peekLowerVideoQuality(emergency = false): CatalogTrack | null {
    if (!this.autoQuality) return null;
    if (!emergency) {
      const now = this.clock.now();
      const cooldownUs = this.qualitySwitchCooldownMs * 1000;
      if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
        return null;
      }
    }
    if (this.videoIndex >= this.videoAlternatives.length - 1) return null;
    return this.videoAlternatives[this.videoIndex + 1] ?? null;
  }

  /**
   * Peek at the next higher quality track WITHOUT mutating state.
   * Returns null if blocked by cooldown, autoQuality, or already at highest.
   */
  peekHigherVideoQuality(): CatalogTrack | null {
    if (!this.autoQuality) return null;
    const now = this.clock.now();
    const cooldownUs = this.qualitySwitchCooldownMs * 1000;
    if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
      return null;
    }
    if (this.videoIndex <= 0) return null;
    return this.videoAlternatives[this.videoIndex - 1] ?? null;
  }

  /**
   * Commit a quality switch. Called after the switch is actually
   * committed to the pipeline/MSE, not when the subscription starts.
   */
  commitVideoTrack(trackName: string): void {
    // A track of another program moves the program; one of another view
    // moves ABR to that view's alternatives.
    const track = this.usableTracks.find(t => t.name === trackName && t.role === 'video');
    const fromProgram = this._currentProgram;
    if (track?.renderGroup !== undefined) this._currentProgram = track.renderGroup;
    const view = this.views.find(v => v.tracks.some(t => t.name === trackName));
    if (view && view !== this.currentViewEntry) {
      this.currentViewEntry = view;
      this.allVideoAlternatives = this.cappedAlternatives(view.tracks);
      this.videoAlternatives = sameCodecFamily(this.allVideoAlternatives, track);
    } else if (!view && this._currentProgram !== fromProgram) {
      // A program without altGroups: its video tracks form the ladder, as at startup.
      this.currentViewEntry = undefined;
      this.allVideoAlternatives = this.cappedAlternatives(
        this.usableTracks.filter(t => t.role === 'video' && inProgram(t, this._currentProgram)));
      this.videoAlternatives = sameCodecFamily(this.allVideoAlternatives, track);
    }
    // A manual pick of another codec family, or of a track above the
    // resolution cap, re-narrows the ladder around it, so currentVideoTrack
    // stays truthful.
    if (track && !this.videoAlternatives.includes(track)) {
      if (!this.allVideoAlternatives.includes(track)) {
        this.allVideoAlternatives = [...this.allVideoAlternatives, track]
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      }
      this.videoAlternatives = sameCodecFamily(this.allVideoAlternatives, track);
    }
    const idx = this.videoAlternatives.findIndex(t => t.name === trackName);
    if (idx >= 0) {
      this.videoIndex = idx;
      this.lastSwitchTimeUs = this.clock.now();
    }
  }

  // ─── Views (altGroups) ─────────────────────────────────────────

  /** Video views of the current program, in catalog order. Empty without altGroups. */
  get views(): readonly VideoView[] {
    const program = this._currentProgram;
    return this.allViews.filter(v => program === undefined || v.renderGroup === undefined || v.renderGroup === program);
  }

  /** altGroup of the current view, or undefined when the catalog has no altGroups. */
  get currentView(): number | undefined { return this.currentViewEntry?.altGroup; }

  /** altGroup of the view that holds `trackName` (any program), or undefined if it is in none. */
  viewOf(trackName: string): number | undefined {
    return this.allViews.find(v => v.tracks.some(t => t.name === trackName))?.altGroup;
  }

  // ─── Programs (renderGroups) and audio ─────────────────────────

  /** Programs of the catalog, in catalog order. Empty without renderGroups. */
  get programs(): readonly CatalogProgram[] { return this.programList; }

  /** renderGroup of the current program, or undefined without renderGroups. */
  get currentProgram(): number | undefined { return this._currentProgram; }

  /**
   * Audio tracks of the current program (shared ones included), in catalog
   * order. A program with no audio of its own falls back to every audio
   * track, so a catalog that tags video and audio with different
   * renderGroups still plays sound.
   */
  get audioTracks(): readonly CatalogTrack[] {
    const audio = this.usableTracks.filter(t => t.role === 'audio');
    const scoped = audio.filter(t => inProgram(t, this._currentProgram));
    return scoped.length > 0 ? scoped : audio;
  }

  /**
   * Commit a switch to another audio track. Bitrate ABR never runs on audio,
   * so a language can only change here, by an explicit selection. The program
   * does not move with audio — `commitProgram` does that for program switches.
   */
  commitAudioTrack(trackName: string): void {
    const track = this.usableTracks.find(t => t.name === trackName && t.role === 'audio');
    if (track) this._audioTrack = track;
  }

  /**
   * Re-read the catalog after an update (delta or re-sent catalog): programs,
   * views and audio tracks follow it, while the current program, view and
   * tracks are kept by name. A current track the update removed stays current
   * until the player switches away from it.
   *
   * @returns Whether the video ABR ladder changed (callers rebuild ABR state).
   */
  updateCatalog(catalog: CatalogState): boolean {
    const usable = catalog.tracks.filter(isTrackPackagingSupported);
    const video = this.currentVideoTrack;
    const ladderBefore = this.videoAlternatives;
    this.usableTracks = usable;
    this.programList = programsOf(usable);
    this.allViews = viewsOf(usable.filter(t => t.role === 'video'));
    if (!this.programList.some(p => p.renderGroup === this._currentProgram)) {
      this._currentProgram = this.programList.find(p => p.tracks.some(t => t.name === video?.name))?.renderGroup
        ?? this.programList[0]?.renderGroup;
    }
    this._audioTrack = usable.find(t => t.role === 'audio' && t.name === this._audioTrack?.name) ?? this._audioTrack;

    const track = usable.find(t => t.role === 'video' && t.name === video?.name);
    if (!track) return false;
    const view = this.views.find(v => v.tracks.includes(track));
    this.currentViewEntry = view;
    this.allVideoAlternatives = this.cappedAlternatives(view
      ? view.tracks
      : usable.filter(t => t.role === 'video' && t.altGroup === undefined && inProgram(t, this._currentProgram)));
    this.videoAlternatives = sameCodecFamily(this.allVideoAlternatives, track);
    this.videoIndex = Math.max(0, this.videoAlternatives.indexOf(track));
    return this.videoAlternatives.length !== ladderBefore.length
      || this.videoAlternatives.some((t, i) => t.name !== ladderBefore[i]?.name);
  }

  /**
   * Remember a language the viewer chose, so a later program switch picks it
   * again — also after a detour through a program without that language.
   */
  rememberLanguage(lang: string): void {
    this.preferredLanguage = lang;
  }

  /**
   * Carry the viewer's choices over from the controller this one replaces
   * (rebuilt after a session migration): a manual quality lock and a picked
   * language.
   */
  adoptViewerChoices(previous: QualityController): void {
    if (!previous.autoQuality) this.autoQuality = false;
    if (previous.preferredLanguage !== undefined) this.preferredLanguage = previous.preferredLanguage;
  }

  /**
   * Make `renderGroup` the current program directly — for a switch that
   * changes no track because the program shares them all with the current one.
   */
  commitProgram(renderGroup: number): void {
    if (this.programList.some(p => p.renderGroup === renderGroup)) this._currentProgram = renderGroup;
  }

  /**
   * The tracks to play when switching to program `renderGroup`, WITHOUT
   * mutating state — commitVideoTrack / commitAudioTrack move the program.
   *
   * Video: the program's first view at the current ABR level. Audio: the
   * current language if the program has it, else the preferred one, else the
   * program's first audio track. Undefined for an unknown program.
   */
  peekProgramTracks(renderGroup: number): SelectedTracks | undefined {
    if (!this.programList.some(p => p.renderGroup === renderGroup)) return undefined;
    const scoped = this.usableTracks.filter(t => inProgram(t, renderGroup));
    const views = this.allViews.filter(v => v.renderGroup === undefined || v.renderGroup === renderGroup);
    // Prefer the program's own views over shared ones.
    const view = views.find(v => v.renderGroup === renderGroup) ?? views[0];
    const videos = view ? view.tracks : scoped.filter(t => t.role === 'video');
    const audios = scoped.filter(t => t.role === 'audio');
    const current = this._audioTrack?.lang;
    const sameLang = current !== undefined ? audios.filter(t => sameLanguage(t.lang, current)) : [];
    return {
      video: this.atCurrentLevel(this.cappedAlternatives(videos)),
      audio: (sameLang.length > 0 ? sameLang : matchingLanguage(audios, this.preferredLanguage))[0],
    };
  }

  /**
   * Initial program: `initialProgram` when it has the requested view (or none
   * was requested), else the program holding `initialView`, else
   * `initialProgram`, else the first video's.
   */
  private initialProgramOf(usable: readonly CatalogTrack[]): number | undefined {
    if (this.programList.length === 0) return undefined;
    const known = (rg: number | undefined) => this.programList.some(p => p.renderGroup === rg);
    const hasView = (rg: number | undefined) => usable.some(t => t.role === 'video' && t.altGroup === this.initialView
      && inProgram(t, rg));
    if (known(this.initialProgram) && (this.initialView === undefined || hasView(this.initialProgram))) {
      return this.initialProgram;
    }
    const viewProgram = usable.find(t => t.role === 'video' && t.altGroup === this.initialView
      && t.renderGroup !== undefined)?.renderGroup;
    if (this.initialView !== undefined && known(viewProgram)) return viewProgram;
    if (known(this.initialProgram)) return this.initialProgram;
    return usable.find(t => t.role === 'video' && t.renderGroup !== undefined)?.renderGroup
      ?? this.programList[0]!.renderGroup;
  }

  /**
   * Pick the track to play when switching to view `altGroup`, WITHOUT
   * mutating state — the view is committed by `commitVideoTrack` once the
   * switch lands.
   *
   * Keeps the current ABR level: the highest-bitrate track of the view that
   * does not exceed the current track's bitrate, else the view's lowest.
   * Returns undefined for an unknown view or one emptied by the resolution cap.
   */
  peekViewTrack(altGroup: number): CatalogTrack | undefined {
    const view = this.views.find(v => v.altGroup === altGroup);
    if (!view) return undefined;
    return this.atCurrentLevel(this.cappedAlternatives(view.tracks));
  }

  /**
   * The highest track of `alts` (sorted) not above the current bitrate, else
   * the lowest — preferring the current codec family, whose switch needs no
   * decoder re-type.
   */
  private atCurrentLevel(alts: readonly CatalogTrack[]): CatalogTrack | undefined {
    const current = this.currentVideoTrack;
    const sameFamily = sameCodecFamily([...alts], current);
    const pool = sameFamily.length > 0 ? sameFamily : alts;
    if (current?.bitrate === undefined) return pool[0];
    return pool.find(t => (t.bitrate ?? 0) <= current.bitrate!) ?? pool[pool.length - 1];
  }

  /**
   * Sort by bitrate (highest first) and drop tracks above the resolution cap.
   * The cap never empties a set: a view whose every track exceeds it (e.g. a
   * portrait canvas under a landscape cap) keeps its smallest track.
   */
  private cappedAlternatives(tracks: readonly CatalogTrack[]): CatalogTrack[] {
    const sorted = [...tracks].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const cap = this.capLevelToResolution;
    if (!cap) return sorted;
    const capped = sorted.filter(t => (t.width ?? 0) <= cap.width && (t.height ?? 0) <= cap.height);
    if (capped.length > 0 || sorted.length === 0) return capped;
    const area = (t: CatalogTrack) => (t.width ?? 0) * (t.height ?? 0);
    return [sorted.reduce((a, b) => (area(b) < area(a) ? b : a))];
  }

  /** Lock to current quality — disables reduce/increase until unlocked. */
  lockManual(): void { this.autoQuality = false; }

  /** Re-enable automatic quality switching. */
  unlockAuto(): void { this.autoQuality = true; }

  /** Whether automatic quality switching is enabled. */
  get isAutoQuality(): boolean { return this.autoQuality; }

  /** ABR alternatives (same codec family, sorted by bitrate highest first). */
  get alternatives(): readonly CatalogTrack[] { return this.videoAlternatives; }

  /** ALL video alternatives including cross-codec (for UI / manual selection). */
  get allAlternatives(): readonly CatalogTrack[] { return this.allVideoAlternatives; }

  /** Current index into the alternatives array. */
  get currentIndex(): number { return this.videoIndex; }

  /** The track one step above current, or null if already at highest. */
  get nextHigherTrack(): CatalogTrack | undefined {
    if (this.videoIndex <= 0) return undefined;
    return this.videoAlternatives[this.videoIndex - 1];
  }
}

/** Alternatives sharing `track`'s codec family ('avc1', 'hvc1', 'av01'); all of them when it has no codec. */
function sameCodecFamily(alts: CatalogTrack[], track: CatalogTrack | undefined): CatalogTrack[] {
  if (!track?.codec) return alts;
  const codecFamily = track.codec.split('.')[0];
  return alts.filter(t => t.codec?.split('.')[0] === codecFamily);
}

/** Whether `track` belongs to program `renderGroup` (shared tracks belong to all). */
function inProgram(track: CatalogTrack, renderGroup: number | undefined): boolean {
  return renderGroup === undefined || track.renderGroup === undefined || track.renderGroup === renderGroup;
}

/** Programs in catalog order of first appearance; each lists its tracks plus the shared ones. */
function programsOf(tracks: readonly CatalogTrack[]): CatalogProgram[] {
  const ids: number[] = [];
  for (const t of tracks) {
    if (t.renderGroup !== undefined && !ids.includes(t.renderGroup)) ids.push(t.renderGroup);
  }
  return ids.map(renderGroup => ({ renderGroup, tracks: tracks.filter(t => inProgram(t, renderGroup)) }));
}

/** Video views keyed by (renderGroup, altGroup), in catalog order; tracks sorted by bitrate. */
function viewsOf(videoTracks: readonly CatalogTrack[]): VideoView[] {
  const views: VideoView[] = [];
  for (const g of groupByAlt(videoTracks).groups) {
    const byProgram = new Map<number | undefined, CatalogTrack[]>();
    for (const t of g.tracks) {
      const list = byProgram.get(t.renderGroup) ?? [];
      list.push(t);
      byProgram.set(t.renderGroup, list);
    }
    for (const [renderGroup, list] of byProgram) {
      views.push({
        altGroup: g.altGroup,
        renderGroup,
        tracks: list.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0)),
      });
    }
  }
  const first = (v: VideoView) => Math.min(...v.tracks.map(t => videoTracks.indexOf(t)));
  return views.sort((a, b) => first(a) - first(b));
}

/** Canonical tag and primary language per raw tag (Intl canonicalization is not free). */
const languageCache = new Map<string, { tag: string; primary: string }>();

/**
 * Canonical form of a language tag: "ES-mx" → "es-MX", and ISO 639-2 codes
 * with a 2-letter form map to it ("spa" → "es", "ger" → "de"). Tags Intl
 * rejects fall back to lower-casing.
 */
function canonicalLanguage(lang: string): { tag: string; primary: string } {
  let entry = languageCache.get(lang);
  if (!entry) {
    try {
      const tag = Intl.getCanonicalLocales(lang.replace(/_/g, '-'))[0]!;
      const primary = new Intl.Locale(tag).language;
      entry = { tag, primary: primary || tag.split('-')[0]!.toLowerCase() };
    } catch {
      const tag = lang.toLowerCase();
      entry = { tag, primary: tag.split(/[-_]/)[0]! };
    }
    languageCache.set(lang, entry);
  }
  return entry;
}

/** Whether two language tags share their primary language, ignoring case and 639-1/639-2 spelling. */
function sameLanguage(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && canonicalLanguage(a).primary === canonicalLanguage(b).primary;
}

/**
 * Tracks in `lang`, best match first: the exact canonical tag ("pt-BR" over
 * "pt-PT"), then the same primary language. All tracks when none match — a
 * preference never empties the list.
 */
function matchingLanguage(tracks: readonly CatalogTrack[], lang: string | undefined): readonly CatalogTrack[] {
  if (lang === undefined) return tracks;
  const wanted = canonicalLanguage(lang).tag.toLowerCase();
  const matches = tracks.filter(t => sameLanguage(t.lang, lang));
  if (matches.length === 0) return tracks;
  const exact = matches.filter(t => canonicalLanguage(t.lang!).tag.toLowerCase() === wanted);
  return [...exact, ...matches.filter(t => !exact.includes(t))];
}
