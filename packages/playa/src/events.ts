/**
 * UI-friendly event map for @playa/player.
 *
 * Event names mirror HTMLMediaElement conventions where possible
 * (timeupdate, volumechange, durationchange) for familiarity.
 * Protocol-level events from @moqt/player are absorbed and re-emitted
 * as higher-level UI events.
 *
 * @module
 */

import type { CatalogState } from '@moqt/msf';
import type { NamespaceState } from '@moqt/player';
import type { Level, AudioTrack, PlayerStats, PlayerState } from './types.js';

/** Event map for Player.on() / Player.off(). */
export interface PlayerEventMap {
  /** Catalog loaded, tracks available, ready for play(). */
  'ready': ReadyEvent;
  /** play() was called. */
  'play': Record<string, never>;
  /** pause() was called. */
  'pause': Record<string, never>;
  /** First frame rendered — media is actually playing. */
  'playing': Record<string, never>;
  /** Stream ended (PUBLISH_DONE). */
  'ended': Record<string, never>;

  /** Periodic current time update (~4Hz). Wire to seek bar. */
  'timeupdate': TimeupdateEvent;
  /** Duration became available or changed. */
  'durationchange': DurationchangeEvent;
  /** Seek started. */
  'seeking': SeekingEvent;
  /** Seek completed. */
  'seeked': SeekedEvent;

  /** Volume or mute state changed. */
  'volumechange': VolumechangeEvent;

  /** Quality levels available from catalog. */
  'levelsloaded': LevelsloadedEvent;
  /** Quality level switched (ABR or manual). */
  'qualitychange': QualitychangeEvent;

  /** Playback stalled. `durationMs` is detection latency, not the outage length. */
  'stall': StallEvent;
  /** A stall ended, with the full outage length. */
  'stall_recovered': StallRecoveredEvent;
  /** The page was suspended or restored by the browser. */
  'lifecycle': LifecycleEvent;
  /** The connection to the relay closed. */
  'session_closed': SessionClosedEvent;
  /** A fresh session will be attempted after `delayMs`. */
  'session_reconnecting': SessionReconnectingEvent;
  /** The relay answered SETUP: the session is established. */
  'session_established': Record<string, never>;
  /** A new session took over, after a reconnect or a relay GOAWAY. */
  'session_migrated': Record<string, never>;
  /** The followed namespace changed state at the relay (`followNamespace`). */
  'namespace_state': NamespaceStateEvent;

  /** Periodic stats update (~1Hz). Wire to stats overlay. */
  'stats': PlayerStats;

  /** Error occurred. Check severity for recovery. */
  'error': ErrorEvent;

  /** Player state changed. */
  'statechange': StatechangeEvent;

  /** Catalog received and parsed. */
  'catalog_received': CatalogEvent;
  /** Delta catalog update applied. */
  'catalog_updated': CatalogEvent;
  /** Raw catalog bytes as delivered, before parsing. Diagnostics only. */
  'catalog_raw': CatalogRawEvent;

  /**
   * One media object arrived. Fires per object — measurement and
   * diagnostics only; playback needs none of it.
   */
  'media_object': MediaObjectEvent;
}

export interface CatalogEvent {
  readonly catalog: CatalogState;
}

export interface CatalogRawEvent {
  readonly bytes: number;
  /** UTF-8 decoding of the payload, or null when it is not valid UTF-8. */
  readonly text: string | null;
}

export interface MediaObjectEvent {
  readonly mediaType: 'video' | 'audio';
  readonly trackName: string;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly kind: string;
  /** Payload size in bytes — the measured contribution to track bitrate. */
  readonly bytes: number;
  /** Publisher capture time, µs since the epoch, when the object carries it. */
  readonly captureTimestamp?: bigint | undefined;
  readonly isKeyframe?: boolean | undefined;
}

export interface ReadyEvent {
  readonly levels: Level[];
  readonly audioTracks: AudioTrack[];
  readonly duration?: number | undefined;
}

export interface TimeupdateEvent {
  readonly currentTime: number;
}

export interface DurationchangeEvent {
  readonly duration: number;
}

export interface SeekingEvent {
  readonly targetTime: number;
}

export interface SeekedEvent {
  readonly currentTime: number;
}

export interface VolumechangeEvent {
  readonly volume: number;
  readonly muted: boolean;
}

export interface LevelsloadedEvent {
  readonly levels: Level[];
}

export interface QualitychangeEvent {
  readonly level: Level;
  readonly auto: boolean;
}

export interface StallEvent {
  readonly durationMs: number;
}

export interface StallRecoveredEvent {
  /** Outage length, onset to recovery. */
  readonly durationMs: number;
}

/** A browser page-lifecycle transition. A frozen tab runs no timers or socket
 *  reads, so its gap otherwise looks like a network failure. */
export interface LifecycleEvent {
  readonly state: 'hidden' | 'visible' | 'frozen' | 'resumed';
  /** How long the page spent away, on the transition back. */
  readonly awayMs?: number;
}

export interface SessionClosedEvent {
  /** Session termination code, when the close carried one. */
  readonly code?: number;
  readonly reason?: string;
}

export interface SessionReconnectingEvent {
  /** 1 for the first attempt after the close. */
  readonly attempt: number;
  readonly delayMs: number;
}

export interface NamespaceStateEvent {
  readonly state: NamespaceState;
  /** The MoQT message behind the change. */
  readonly detail: string;
}

export interface ErrorEvent {
  readonly severity: 'fatal' | 'recoverable';
  readonly code: number;
  readonly message: string;
}

export interface StatechangeEvent {
  readonly state: PlayerState;
}
