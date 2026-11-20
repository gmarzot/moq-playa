import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { broadcasterPageQuery, playerPageQuery, variantProfile } from './pages.mjs';

const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));

describe('soak page URLs', () => {
  const c = { url: 'https://relay.example/', namespace: 'ci/x/loc', draft: 22, packaging: 'loc' };

  it('appends the player query last, overriding', () => {
    const q = playerPageQuery(c, 'congestionControl=throughput&log=debug');
    expect(q.get('congestionControl')).toBe('throughput');
    expect(q.get('log')).toBe('debug');
    expect(q.get('output')).toBe('canvas');
    expect(q.get('ns')).toBe('ci/x/loc');
    expect(playerPageQuery(c).has('congestionControl')).toBe(false);
    expect(playerPageQuery({ ...c, profile: { latency: 'smooth' } }).get('latency')).toBe('smooth');
  });

  it('runs group-burst on a burst broadcaster with 2.5 s groups and unshaped players', () => {
    const profile = cases.profiles['group-burst'];
    expect(profile).toMatchObject({ variant: 'burst' });
    expect(profile.netem ?? profile.down ?? profile.up ?? profile.events).toBeUndefined();
    const b = { namespace: 'ci/x/aiomoqt-relay/cmaf/burst', packaging: 'cmaf', params: cases.broadcastParams,
      relayInfo: cases.relays['aiomoqt-relay'] };
    const q = broadcasterPageQuery(b, variantProfile(cases, 'burst').broadcastQuery);
    expect(q.get('groupBurst')).toBe('1');
    expect(q.get('keyframeSec')).toBe('2.5');
    expect(q.get('fps')).toBe(String(cases.broadcastParams.fps));
    expect(broadcasterPageQuery(b).has('groupBurst')).toBe(false);
    expect(variantProfile(cases, 'restart').name).toBe('republish');
    expect(() => variantProfile(cases, 'nope')).toThrow(/variant nope/);
  });
});
