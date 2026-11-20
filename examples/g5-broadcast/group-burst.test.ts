import { describe, it, expect } from 'vitest';
import { GroupBurstConnection } from './group-burst.js';
import { MediaPublisher } from './media-publisher.js';
import type { MediaPublishConnection } from './media-publisher.js';

type Call = ['open', bigint] | ['send', bigint, bigint] | ['close', bigint] | ['datagram', bigint];

function fakeConnection(opts: { failOpen?: boolean } = {}) {
  const calls: Call[] = [];
  let next = 100n;
  const conn: MediaPublishConnection & { calls: Call[] } = {
    calls,
    openSubgroup: async (_alias, groupId) => {
      if (opts.failOpen) throw new Error('refused');
      const id = next++;
      calls.push(['open', groupId as bigint]);
      return id;
    },
    sendObject: async (streamId, objectId) => { calls.push(['send', streamId, objectId as bigint]); },
    closeSubgroup: async (streamId) => { calls.push(['close', streamId]); },
    sendDatagram: async (_alias, groupId) => { calls.push(['datagram', groupId]); },
  };
  return conn;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const bytes = (n: number) => new Uint8Array(n);

describe('GroupBurstConnection', () => {
  it('holds calls until flush, then replays them in order on real stream IDs', async () => {
    const inner = fakeConnection();
    const burst = new GroupBurstConnection(inner);
    const s = await burst.openSubgroup(1n, 7n, 0n, {});
    expect(s).toBeLessThan(0n);
    await burst.sendObject(s, 0n, bytes(10));
    await burst.sendObject(s, 1n, bytes(10));
    await burst.sendDatagram(2n, 9n, 0n, bytes(5));
    await burst.closeSubgroup(s);
    await settle();
    expect(inner.calls).toEqual([]);
    expect(burst.bytesHeld).toBe(25);
    burst.flush();
    await settle();
    expect(inner.calls).toEqual([['open', 7n], ['send', 100n, 0n], ['send', 100n, 1n], ['datagram', 9n], ['close', 100n]]);
    expect(burst.bytesHeld).toBe(0);
  });

  it('sends the rest of a group unheld above the cap, and holds again after the next flush', async () => {
    const inner = fakeConnection();
    const logs: string[] = [];
    const burst = new GroupBurstConnection(inner, { maxBytes: 15, onLog: (m) => logs.push(m) });
    const s = await burst.openSubgroup(1n, 1n, 0n, {});
    await burst.sendObject(s, 0n, bytes(10));
    await settle();
    expect(inner.calls).toEqual([]);
    await burst.sendObject(s, 1n, bytes(10));
    await burst.sendObject(s, 2n, bytes(10));
    await settle();
    expect(inner.calls).toHaveLength(4);
    expect(burst.counts.capped).toBe(1);
    expect(logs).toHaveLength(1);
    burst.flush();
    await burst.sendObject(s, 3n, bytes(1));
    await settle();
    expect(inner.calls).toHaveLength(4);
  });

  it('reports a failed open and skips the sends on its stream', async () => {
    const errors: string[] = [];
    const burst = new GroupBurstConnection(fakeConnection({ failOpen: true }), { onError: (c) => errors.push(c) });
    const s = await burst.openSubgroup(1n, 1n, 0n, {});
    await burst.sendObject(s, 0n, bytes(1));
    burst.flush();
    await settle();
    expect(errors).toEqual(['group burst send']);
    expect(burst.counts.failures).toBe(1);
  });

  it('close drops what is held and passes later calls through', async () => {
    const inner = fakeConnection();
    const burst = new GroupBurstConnection(inner);
    const s = await burst.openSubgroup(1n, 1n, 0n, {});
    await burst.sendObject(s, 0n, bytes(1));
    await burst.close();
    await burst.closeSubgroup(s);
    const real = await burst.openSubgroup(1n, 2n, 0n, {});
    await burst.sendObject(real, 0n, bytes(1));
    expect(inner.calls).toEqual([['open', 2n], ['send', 100n, 0n]]);
  });
});

describe('MediaPublisher with groupBurst', () => {
  it("sends a group's video and the audio published meanwhile when the next group starts", async () => {
    const inner = fakeConnection();
    const pub = new MediaPublisher(inner, { wrapInt: (n) => n, draft: 16, groupBurst: {} });
    pub.addVideoAlias(2n);
    pub.addAudioAlias(3n);
    pub.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 0 });
    pub.publishAudio(new Uint8Array([2]), { timestampUs: 0 });
    pub.publishVideo(new Uint8Array([3]), { isKeyframe: false, timestampUs: 33_000 });
    await settle();
    expect(inner.calls).toEqual([]);
    pub.publishVideo(new Uint8Array([4]), { isKeyframe: true, timestampUs: 66_000 });
    await settle();
    await settle();
    expect(inner.calls.filter((c) => c[0] === 'send')).toHaveLength(3);
    expect(inner.calls.filter((c) => c[0] === 'open')).toHaveLength(2);
    expect(inner.calls.filter((c) => c[0] === 'close')).toHaveLength(2);
    await pub.stop();
    expect(inner.calls).toHaveLength(7);
  });

  it('is off without the option', async () => {
    const inner = fakeConnection();
    const pub = new MediaPublisher(inner, { wrapInt: (n) => n, draft: 16 });
    pub.addVideoAlias(2n);
    pub.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 0 });
    await settle();
    expect(inner.calls.map((c) => c[0])).toEqual(['open', 'send']);
  });
});
