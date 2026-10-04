/**
 * @playa/player — Batteries-included MoQ media player.
 *
 * ```ts
 * import { Player } from '@playa/player';
 * const player = new Player(container, { url, namespace });
 * await player.load();
 * player.play();
 * ```
 *
 * @module
 */

export { Player } from './player.js';
export type { PlayerOptions, Level, AudioTrack, PlayerStats, PlayerState } from './types.js';
export type {
  PlayerEventMap,
  ReadyEvent,
  TimeupdateEvent,
  DurationchangeEvent,
  SeekingEvent,
  SeekedEvent,
  VolumechangeEvent,
  LevelsloadedEvent,
  QualitychangeEvent,
  StallEvent,
  StallRecoveredEvent,
  LifecycleEvent,
  SessionClosedEvent,
  SessionReconnectingEvent,
  ErrorEvent,
  StatechangeEvent,
} from './events.js';
export type { SubscriptionStatus } from '@moqt/player';
export { detectStrategy } from './auto-detect.js';
export type { DecoderStrategy } from './auto-detect.js';
