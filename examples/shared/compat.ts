/**
 * `?compat=` — opt-in interop behaviours for relays that deviate from the
 * spec, comma-separated. URL only; none by default.
 *
 * - `request-credit`: SERVER_SETUP without MAX_REQUEST_ID still lets requests
 *   out, uncapped until the relay sends one.
 * - `empty-objects`: empty Normal objects on media tracks are skipped and
 *   counted (player only).
 */

import type { PlayerCompat } from '@openmoq/player';

const KNOWN: readonly PlayerCompat[] = ['request-credit', 'empty-objects'];

/** The recognised behaviours, and any names that were not. */
export function parseCompat(value: string | null): { compat: PlayerCompat[]; unknown: string[] } {
  const compat: PlayerCompat[] = [];
  const unknown: string[] = [];
  for (const name of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if ((KNOWN as readonly string[]).includes(name)) compat.push(name as PlayerCompat);
    else unknown.push(name);
  }
  return { compat, unknown };
}
