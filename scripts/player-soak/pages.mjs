/** Page URLs the soak opens: the acceptance player and the g5-broadcast broadcaster. */

/**
 * The acceptance page's query for case `c`. `extra` (a query string, e.g.
 * `congestionControl=throughput`) is set last, so it overrides.
 * Viewers play as G5 does: from the current group, following the namespace, logging at info.
 */
export function playerPageQuery(c, extra = '') {
  const query = new URLSearchParams({ url: c.url, ns: c.namespace, v: String(c.draft), soak: '1', warmStart: '1',
    followNamespace: '1', log: 'info' });
  if (c.packaging === 'loc') query.set('output', 'canvas');
  if (c.packaging === 'locmaf') query.set('locmaf', 'mse');
  const latency = c.latency ?? c.profile?.latency;
  if (latency) query.set('latency', latency);
  if (c.auto) query.set('auto', '1');
  if (c.level !== undefined) query.set('level', String(c.level));
  for (const [k, v] of new URLSearchParams(extra)) query.set(k, v);
  return query;
}

/** The profile whose broadcaster runs as `variant`; throws when none does. */
export function variantProfile(cases, variant) {
  const entry = Object.entries(cases.profiles).find(([, p]) => p.variant === variant);
  if (!entry) throw new Error(`no profile has variant ${variant}`);
  return { name: entry[0], ...entry[1] };
}

/** The g5-broadcast page's query for broadcast `b`, plus a variant's `broadcastQuery`. */
export function broadcasterPageQuery(b, variantQuery = {}) {
  const p = b.params;
  const query = new URLSearchParams({ url: b.relayInfo.url, ns: b.namespace, v: String(b.relayInfo.publishDraft),
    packaging: b.packaging, height: String(p.height), fps: String(p.fps), bitrate: String(p.bitrate), target: String(p.target),
    clockUrl: 'https://aiomoqt-relay.marzresearch.net/time' });
  for (const [k, v] of Object.entries(variantQuery)) query.set(k, String(v));
  return query;
}
