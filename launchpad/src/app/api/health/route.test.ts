import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GET } from './route';

describe('GET /api/health', () => {
  it('answers 200 ok, uncached', async () => {
    const res = await GET();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: 'ok' });
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  });
});
