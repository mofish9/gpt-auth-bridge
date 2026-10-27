import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSub2ApiSettings, sub2ApiAccountDefaults } from './sub2api-settings.js';

test('normalizes account delivery settings and expiry units', () => {
  const settings = normalizeSub2ApiSettings({
    expiresAt: '1780000000000',
    autoPauseOnExpired: 'false',
    imageBridgeStrategy: 'strip',
    wsMode: 'http_bridge',
  });
  assert.equal(settings.expiresAt, 1780000000);
  assert.equal(settings.autoPauseOnExpired, false);
  assert.equal(settings.imageBridgeStrategy, 'strip');
  assert.equal(settings.wsMode, 'http_bridge');
});

test('falls back to safe delivery defaults for invalid values', () => {
  const defaults = sub2ApiAccountDefaults({ expiresAt: 'invalid', imageBridgeStrategy: 'bad', wsMode: 'bad' });
  assert.equal(defaults.expiresAt, null);
  assert.equal(defaults.autoPauseOnExpired, true);
  assert.equal(defaults.imageBridgeStrategy, 'inherit');
  assert.equal(defaults.wsMode, 'off');
});
