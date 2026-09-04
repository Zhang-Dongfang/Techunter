import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopCorsMethods } from './http-policy.js';

test('Desktop CORS policy permits every API method used by the renderer', () => {
  assert.deepEqual(desktopCorsMethods, ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS']);
});
