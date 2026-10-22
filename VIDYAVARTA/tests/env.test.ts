import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalEnv } from '../src/campus/env';

test('a local .env file is loaded once, without overriding real environment variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vidyavarta-env-'));
  writeFileSync(join(dir, '.env'), [
    '# comment line',
    'VIDYAVARTA_TEST_ENV_A=from-file',
    'VIDYAVARTA_TEST_ENV_B="quoted value"',
    'VIDYAVARTA_TEST_ENV_B_OVERRIDE=preset-wins',
    '',
  ].join('\n'));
  process.env.VIDYAVARTA_TEST_ENV_B_OVERRIDE = 'preset';
  try {
    loadLocalEnv(dir);
    assert.equal(process.env.VIDYAVARTA_TEST_ENV_A, 'from-file');
    assert.equal(process.env.VIDYAVARTA_TEST_ENV_B, 'quoted value');
    assert.equal(process.env.VIDYAVARTA_TEST_ENV_B_OVERRIDE, 'preset', 'a real environment variable wins over the file');
  } finally {
    delete process.env.VIDYAVARTA_TEST_ENV_A;
    delete process.env.VIDYAVARTA_TEST_ENV_B;
    delete process.env.VIDYAVARTA_TEST_ENV_B_OVERRIDE;
    rmSync(dir, { recursive: true, force: true });
  }
});
