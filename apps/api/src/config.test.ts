import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from './config.js';

test('central API requires Supabase and keeps Techunter Web origins explicit', () => {
  const value = parseConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-long-enough',
    TECHUNTER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    TECHUNTER_PUBLIC_URL: 'https://api.techunter.example',
    TECHUNTER_WEB_ORIGINS: 'https://techunter.example,http://127.0.0.1:5173',
  });
  assert.equal(value.publicUrl, 'https://api.techunter.example');
  assert.deepEqual(value.webOrigins, ['https://techunter.example', 'http://127.0.0.1:5173']);
  assert.equal(value.ai.accessMode, 'conexus');
});
