import { describe, expect, it } from 'vitest';
import { orderCatalogForDisplay } from './msf-order.js';

const keys = (v: unknown): string[] => Object.keys(v as object);

describe('orderCatalogForDisplay', () => {
  it('orders root and track fields by group, unlisted fields last in arrival order', () => {
    const cat = {
      tracks: [{
        bitrate: 2_000_000, zeta: 1, codec: 'avc1', name: 'video', height: 720, width: 1280,
        alpha: 2, role: 'video', packaging: 'locmaf', locmafVersion: '0.3', isLive: true,
      }],
      initDataList: [],
      custom: true,
      generatedAt: 1,
      version: '1',
    };
    const out = orderCatalogForDisplay(cat) as { tracks: unknown[] };
    expect(keys(out)).toEqual(['version', 'generatedAt', 'tracks', 'initDataList', 'custom']);
    expect(keys(out.tracks[0])).toEqual([
      'name', 'packaging', 'locmafVersion', 'isLive', 'role', 'codec', 'width', 'height', 'bitrate', 'zeta', 'alpha',
    ]);
  });

  it('keeps values, passes non-objects through, and keeps a __proto__ key a plain field', () => {
    expect(orderCatalogForDisplay('x')).toBe('x');
    expect(orderCatalogForDisplay(null)).toBe(null);
    const cat = JSON.parse('{"tracks":[{"name":"a","__proto__":{"polluted":1}}],"version":"1"}');
    const out = orderCatalogForDisplay(cat) as { tracks: Array<Record<string, unknown>> };
    expect(JSON.stringify(out)).toBe('{"version":"1","tracks":[{"name":"a","__proto__":{"polluted":1}}]}');
    expect(Object.getPrototypeOf(out.tracks[0])).toBe(Object.prototype);
  });
});
