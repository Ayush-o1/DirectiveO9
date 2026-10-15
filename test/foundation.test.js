import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Foundation sanity check', () => {
  it('verifies test runner is operational', () => {
    assert.equal(1 + 1, 2);
  });
});
