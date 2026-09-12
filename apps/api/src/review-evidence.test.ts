import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewEvidence } from './agent-service.js';

test('review evidence includes file tails and binary encoding instead of silently truncating', () => {
  const tail = 'x'.repeat(31_000) + '\nimportant validation at end';
  const files = [{ path: 'large.ts', content: tail, encoding: 'utf-8' as const }, { path: 'image.png', content: 'AA==', encoding: 'base64' as const }];
  assert.deepEqual(reviewEvidence({ title: 'task', description: '', acceptanceCriteria: ['works'], changedFiles: files, testOutput: '', summary: 'done' }), files);
  assert.throws(() => reviewEvidence({ title: 'task', description: '', acceptanceCriteria: [], changedFiles: [{ path: 'huge.ts', content: 'x'.repeat(260_000), encoding: 'utf-8' }], testOutput: '', summary: 'done' }), /未截断/);
});
