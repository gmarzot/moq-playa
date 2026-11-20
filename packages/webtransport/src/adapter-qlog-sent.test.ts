/**
 * qlog control_message_created covers every send path: the control stream and,
 * from draft 18, the per-request streams.
 */
import { describe, it, expect } from 'vitest';
import type { ControlMessage } from '@openmoq/transport';
import { flush } from './testkit/loopback.js';
import { connectedPair, ns, nm } from './testkit/pair.js';

describe('MoqtConnection qlog — control_message_created on every send path', () => {
  for (const version of [16, 18, 22] as const) {
    it(`draft-${version}: SUBSCRIBE and REQUEST_UPDATE are each reported once as sent`, async () => {
      const pair = await connectedPair(version);
      pair.server.setLargestLocationProvider(() => ({ group: 9n, object: 0n }));
      let subReqId = -1n;
      pair.server.onSubscribe = (rid) => { subReqId = rid; };
      const sent: ControlMessage[] = [];
      pair.client.onQlogEvent = (e) => {
        if (e.type === 'control_message_created') sent.push((e as { message: ControlMessage }).message);
      };

      const reqId = await pair.client.subscribe(ns('live'), nm('vid'), { forward: 1 } as never);
      await flush();
      await pair.server.acceptSubscribe(subReqId, 7n);
      await flush();
      await pair.client.requestUpdate(reqId, { forward: 0 });
      await flush(); await flush();

      expect(sent.filter((m) => m.type === 'SUBSCRIBE')).toHaveLength(1);
      const updates = sent.filter((m) => m.type === 'REQUEST_UPDATE');
      expect(updates).toHaveLength(1);
      expect(pair.errors).toEqual([]);
    });
  }

  it('a throwing qlog observer on a request-stream send is contained', async () => {
    const pair = await connectedPair(18);
    let subReqId = -1n;
    pair.server.onSubscribe = (rid) => { subReqId = rid; };
    pair.client.onQlogEvent = () => { throw new Error('observer exploded'); };
    await pair.client.subscribe(ns('live'), nm('vid'));
    await flush();
    expect(subReqId).not.toBe(-1n);
  });
});
