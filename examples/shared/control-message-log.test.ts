import { describe, expect, it } from 'vitest';
import { describeControlMessage } from './control-message-log.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('describeControlMessage', () => {
  it('names message parameters', () => {
    const update = {
      type: 'REQUEST_UPDATE',
      requestId: 6n,
      existingRequestId: 4n,
      parameters: new Map([[0x10n, [1n]], [0x32n, [7n]]]),
    };
    expect(describeControlMessage(update)).toBe('REQUEST_UPDATE requestId=6 existingRequestId=4 FORWARD=1 NEW_GROUP_REQUEST=7');
  });

  it('reads a namespace as its path and a track name as text', () => {
    const subscribe = {
      type: 'SUBSCRIBE',
      requestId: 4n,
      trackNamespace: [text('openmoq'), text('night')],
      trackName: text('video-0'),
      parameters: new Map(),
    };
    expect(describeControlMessage(subscribe)).toBe('SUBSCRIBE requestId=4 trackNamespace=openmoq/night trackName="video-0"');
  });

  it('shows binary values by size, unknown codes in hex, and Track Properties by code', () => {
    const ok = {
      type: 'SUBSCRIBE_OK',
      requestId: 4n,
      trackAlias: 2n,
      parameters: new Map([[0x7fn, [new Uint8Array([0, 1, 2])]]]),
      trackProperties: new Map([[0x30n, [1n]]]),
    };
    expect(describeControlMessage(ok)).toBe('SUBSCRIBE_OK requestId=4 trackAlias=2 0x7f=3B trackProperties={0x30:[1]}');
  });

  it('names setup parameters as such and leaves out empty maps and the trackExtensions alias', () => {
    const setup = { type: 'CLIENT_SETUP', parameters: new Map([[0x02n, [10000n]], [0x07n, [text('proto-moq')]]]) };
    expect(describeControlMessage(setup)).toBe('CLIENT_SETUP MAX_REQUEST_ID=10000 MOQT_IMPLEMENTATION="proto-moq"');
    const props = new Map([[0x30n, [1n]]]);
    const ok = { type: 'SUBSCRIBE_OK', requestId: 4n, trackAlias: 2n, parameters: new Map(), trackProperties: props, trackExtensions: props };
    expect(describeControlMessage(ok)).toBe('SUBSCRIBE_OK requestId=4 trackAlias=2 trackProperties={0x30:[1]}');
    const d16 = { type: 'SUBSCRIBE_OK', requestId: 4n, trackAlias: 2n, parameters: new Map(), trackExtensions: new Map() };
    expect(describeControlMessage(d16)).toBe('SUBSCRIBE_OK requestId=4 trackAlias=2');
  });

  it('redacts authorization tokens', () => {
    const subscribe = {
      type: 'SUBSCRIBE',
      requestId: 2n,
      parameters: new Map([[0x03n, [text('secret-token')]], [0x10n, [1n]]]),
    };
    expect(describeControlMessage(subscribe)).toBe('SUBSCRIBE requestId=2 AUTHORIZATION_TOKEN=<redacted>×1 FORWARD=1');
    const setup = { type: 'SETUP', setupOptions: new Map([[0x01n, [text('/moq')]], [0x03n, [text('secret')]]]) };
    expect(describeControlMessage(setup)).toBe('SETUP PATH="/moq" AUTHORIZATION_TOKEN=<redacted>×1');
    const typed = { type: 'CLIENT_SETUP', authTokens: [{ alias: 1n, tokenValue: text('secret') }] };
    expect(describeControlMessage(typed)).toBe('CLIENT_SETUP authTokens=<redacted>');
    const nested = { type: 'X', options: { tokenValue: text('secret'), alias: 1n } };
    expect(describeControlMessage(nested)).toBe('X options={tokenValue:<redacted> alias:1}');
  });

  it('caps the line', () => {
    const line = describeControlMessage({ type: 'GOAWAY', newSessionUri: text('x'.repeat(60)) }, 40);
    expect(line).toHaveLength(40);
    expect(line.endsWith('…')).toBe(true);
  });
});
