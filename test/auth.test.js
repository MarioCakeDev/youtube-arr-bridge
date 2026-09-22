import test from 'node:test';
import assert from 'node:assert/strict';
import { secureEqual } from '../src/auth.js';
import { secureEqual as serverSecureEqual } from '../src/server.js';

test('secureEqual accepts an identical key and rejects near misses', () => {
  assert.equal(secureEqual('correcthorse', 'correcthorse'), true);
  assert.equal(secureEqual('correcthorse', 'correcthorsE'), false);
  assert.equal(secureEqual('correcthorse', 'correcthorsebattery'), false);
});

test('secureEqual handles empty and missing values without throwing', () => {
  assert.equal(secureEqual('', ''), true);
  assert.equal(secureEqual(undefined, ''), true);
  assert.equal(secureEqual('', 'x'), false);
  assert.equal(secureEqual(null, null), true);
});

test('server.js re-exports the shared secureEqual', () => {
  assert.equal(serverSecureEqual, secureEqual);
});
