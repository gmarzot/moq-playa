import { describe, expect, it } from 'vitest';
import { decodeFillParameters } from './fill-parameters.js';
import { encodeFillParameters } from './subscription-filter.js';
import type { SubscriptionFilter } from './subscription-filter.js';

const filter: SubscriptionFilter = { type: 'LargestObject' };

describe('FILL_PARAMETERS value forms', () => {
    it('writes a Number of Parameters and reads it back', () => {
        const bytes = encodeFillParameters(filter, 'descending');
        expect(bytes[0]).toBe(2);
        expect(decodeFillParameters(bytes)).toMatchObject({ filter, groupOrder: 'descending' });
    });

    it('reads a value with no count as bare parameters', () => {
        const bare = encodeFillParameters({ type: 'LargestObject' }).subarray(1);
        expect(decodeFillParameters(bare)).toMatchObject({ filter });
    });

    it('reads an empty value as no parameters', () => {
        expect(decodeFillParameters(new Uint8Array()).parameters.size).toBe(0);
    });

    it('rejects a counted block with bytes after it', () => {
        const counted = encodeFillParameters(filter);
        expect(() => decodeFillParameters(new Uint8Array([...counted, 0x00]))).toThrow();
    });

    it('rejects a count the value cannot satisfy', () => {
        const bare = encodeFillParameters(filter).subarray(1);
        expect(() => decodeFillParameters(new Uint8Array([5, ...bare]))).toThrow();
    });
});
