import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Player } from './player.js';

beforeEach(() => {
  vi.stubGlobal('document', {
    hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    createElement: () => ({ style: {}, appendChild: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      getContext: vi.fn(() => ({ drawImage: vi.fn() })) }),
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Player — page lifecycle', () => {
  it('a page that becomes visible or resumes reconnects now; hiding does not', async () => {
    const player = new Player({ style: {}, appendChild: vi.fn() } as never, { url: 'https://relay.example/moq', namespace: 'test' });
    const reconnectNow = vi.spyOn((player as any).engine, 'reconnectNow').mockImplementation(() => {});
    try {
      (player as any).onLifecycle('hidden');
      expect(reconnectNow).not.toHaveBeenCalled();
      (player as any).onLifecycle('visible');
      (player as any).onLifecycle('resumed');
      expect(reconnectNow).toHaveBeenCalledTimes(2);
    } finally { await player.destroy(); }
  });
});
