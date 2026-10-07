/**
 * Forward State of an accepted subscription on the draft-18 loopback.
 * @see draft-ietf-moq-transport-18 §5.1
 */
import { describe, it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { flush } from './testkit/loopback.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { SessionState } from '@openmoq/transport';

describe('MoqtConnection loopback — Forward State of an accepted subscription', () => {
  async function accepted(version: 16 | 18) {
    const pair = await connectedPair(version);
    // draft-18 needs the new Joining Location to accept a Forward 0→1 update.
    pair.server.setLargestLocationProvider(() => ({ group: 9n, object: 0n }));
    let subReqId = -1n;
    pair.server.onSubscribe = (rid) => { subReqId = rid; };
    const changes: Array<[bigint, boolean]> = [];
    pair.server.onSubscribeForwardStateChange = (rid, forward) => { changes.push([rid, forward]); };
    const reqId = await pair.client.subscribe(ns('live'), nm('vid'), { forward: 1 } as never);
    await flush();
    await pair.server.acceptSubscribe(subReqId, 7n);
    await flush();
    return { ...pair, subReqId, reqId, changes };
  }

  for (const version of [18, 16] as const) {
    it(`draft-${version}: a pause and a resume are each reported once, and the getter agrees`, async () => {
      const { client, server, subReqId, reqId, changes, errors } = await accepted(version);
      expect(server.getSubscribeForwardState(subReqId)).toBe(true);

      await client.requestUpdate(reqId, { forward: 0 });
      await flush(); await flush();
      expect(changes).toEqual([[subReqId, false]]);
      expect(server.getSubscribeForwardState(subReqId)).toBe(false);

      await client.requestUpdate(reqId, { forward: 0 });       // no change
      await flush(); await flush();
      expect(changes).toHaveLength(1);

      await client.requestUpdate(reqId, { forward: 1 });
      await flush(); await flush();
      expect(changes).toEqual([[subReqId, false], [subReqId, true]]);
      expect(server.getSubscribeForwardState(subReqId)).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  it('a throwing observer is reported as an error and the session stays up', async () => {
    const { client, server, reqId, errors } = await accepted(18);
    server.onSubscribeForwardStateChange = () => { throw new Error('observer bug'); };
    await client.requestUpdate(reqId, { forward: 0 });
    await flush(); await flush();
    expect(errors.map((e) => e.message)).toContain('observer bug');
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('an update to a subscription not yet accepted is not reported, and the getter reads it after', async () => {
    const { client, server } = await connectedPair(18);
    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };
    const changes: Array<[bigint, boolean]> = [];
    server.onSubscribeForwardStateChange = (rid, forward) => { changes.push([rid, forward]); };
    const reqId = await client.subscribe(ns('live'), nm('vid'), { forward: 1 } as never);
    await flush();

    // Its REQUEST_OK waits for SUBSCRIBE_OK, so the call is left pending here.
    void client.requestUpdate(reqId, { forward: 0 }).catch(() => { /* not under test */ });
    await flush(); await flush();
    expect(changes).toEqual([]);

    await server.acceptSubscribe(subReqId, 7n);
    await flush();
    expect(changes).toEqual([]);
    expect(server.getSubscribeForwardState(subReqId)).toBe(false);
  });
});
