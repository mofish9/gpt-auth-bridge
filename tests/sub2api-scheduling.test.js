import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSchedulingSettings, schedulingCredentials, applySchedulingCredentials, schedulingCredentialsMatch, validateSchedulingCredentials } from '../docs/sub2api-scheduling.js';
import { normalizeSub2ApiSettings, sub2ApiAccountDefaults } from '../login-service/lib/sub2api-settings.js';
import { buildSub2ApiAccount, assertSub2ApiAccountShape } from '../login-service/lib/export-sub2api.js';
import { Sub2ApiClient } from '../login-service/lib/sub2api-client.js';

const settings = {
  openaiOverloadCooldownEnabled: true, openaiOverloadCooldownMinutes: 17,
  tempUnschedulableEnabled: true,
  tempUnschedulableOverloadMinutes: 3, tempUnschedulableOverloadScope: 'account',
  tempUnschedulableRateLimitMinutes: 5,
};
const record = { email: 'fixture@example.com', account_id: 'fixture-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh' };

test('legacy settings keep protection disabled; browser and backend produce identical policies', () => {
  const legacy = schedulingCredentials();
  assert.equal(legacy.openai_overload_cooldown_enabled, false);
  assert.equal(legacy.temp_unschedulable_enabled, false);
  assert.deepEqual(legacy.temp_unschedulable_rules, []);
  const policy = schedulingCredentials(settings);
  assert.deepEqual(schedulingCredentials(sub2ApiAccountDefaults(normalizeSub2ApiSettings(settings))), policy);
  assert.deepEqual(policy.temp_unschedulable_rules, [
    { error_code: 529, keywords: ['overloaded', 'too many'], duration_minutes: 3, scope: 'account' },
    { error_code: 429, keywords: ['rate limit', 'too many requests'], duration_minutes: 5, scope: 'model' },
  ]);
  assert.deepEqual(schedulingCredentials({ ...settings, tempUnschedulableOverloadEnabled: false }).temp_unschedulable_rules.map(rule => rule.error_code), [429]);
  const disabled = normalizeSchedulingSettings({ ...settings, tempUnschedulableEnabled: false });
  assert.equal(disabled.tempUnschedulableOverloadMinutes, 3);
  assert.deepEqual(schedulingCredentials(disabled).temp_unschedulable_rules, []);
});

test('invalid durations, empty enabled rules and malformed wire values fail before remote writes', () => {
  for (const value of [0, 121, 1.5, '', 'invalid']) assert.throws(() => normalizeSchedulingSettings({ ...settings, openaiOverloadCooldownMinutes: value }), /1–120/);
  for (const value of [0, -1, 1.5]) assert.throws(() => normalizeSchedulingSettings({ ...settings, tempUnschedulableOverloadMinutes: value }), /正整数/);
  assert.throws(() => normalizeSchedulingSettings({ ...settings, tempUnschedulableOverloadEnabled: false, tempUnschedulableRateLimitEnabled: false }), /至少选择/);
  assert.throws(() => validateSchedulingCredentials({ openai_overload_cooldown_enabled: 'true' }), /布尔值/);
  const account = buildSub2ApiAccount(record, settings);
  assert.equal(assertSub2ApiAccountShape(account), 'rt');
  account.credentials.temp_unschedulable_rules[0].keywords = [];
  assert.throws(() => assertSub2ApiAccountShape(account), /关键词/);
});

test('imported policies are preserved independently unless explicitly overridden', () => {
  const original = { access_token: 'fixture-access', openai_overload_cooldown_enabled: true, openai_overload_cooldown_minutes: 23,
    temp_unschedulable_enabled: true, temp_unschedulable_rules: [
      { error_code: 503, keywords: ['custom capacity'], duration_minutes: 7, scope: 'account', description: 'custom rule' },
    ] };
  const copy = structuredClone(original);
  assert.deepEqual(applySchedulingCredentials(original, settings), original);
  assert.deepEqual(applySchedulingCredentials(original), original);
  assert.deepEqual(original, copy, 'Applying output settings must not mutate imported credentials');
  const partial = applySchedulingCredentials({ access_token: 'fixture-access', openai_overload_cooldown_enabled: true }, settings);
  assert.equal(partial.openai_overload_cooldown_enabled, true);
  assert.equal(Object.hasOwn(partial, 'openai_overload_cooldown_minutes'), false, 'Do not change an imported policy by filling missing fields');
  assert.deepEqual(partial.temp_unschedulable_rules, schedulingCredentials(settings).temp_unschedulable_rules);
  const configured = applySchedulingCredentials(original, { ...settings, schedulingPolicyMode: 'override' });
  assert.deepEqual(configured, { access_token: original.access_token, ...schedulingCredentials(settings) });
  assert.deepEqual(applySchedulingCredentials({}, settings), schedulingCredentials(settings));
  assert.equal(normalizeSub2ApiSettings({ schedulingPolicyMode: 'override' }).schedulingPolicyMode, 'override');
  assert.throws(() => normalizeSchedulingSettings({ schedulingPolicyMode: 'invalid' }), /调度保护配置/);
});

test('disabling a policy or rule restores invalid inactive durations without weakening active validation', () => {
  const disabled = normalizeSchedulingSettings({ ...settings, openaiOverloadCooldownEnabled: false,
    openaiOverloadCooldownMinutes: 0, tempUnschedulableEnabled: false,
    tempUnschedulableOverloadMinutes: '', tempUnschedulableRateLimitMinutes: 1.5 }, settings);
  assert.equal(disabled.openaiOverloadCooldownMinutes, 17);
  assert.equal(disabled.tempUnschedulableOverloadMinutes, 3);
  assert.equal(disabled.tempUnschedulableRateLimitMinutes, 5);
  assert.equal(disabled.tempUnschedulableOverloadEnabled, true);
  const policy = schedulingCredentials(disabled);
  assert.equal(policy.openai_overload_cooldown_enabled, false);
  assert.equal(policy.temp_unschedulable_enabled, false);
  assert.deepEqual(policy.temp_unschedulable_rules, []);
  validateSchedulingCredentials(policy);
  const oneRule = normalizeSchedulingSettings({ ...settings, tempUnschedulableOverloadEnabled: false,
    tempUnschedulableOverloadMinutes: 0 }, settings);
  assert.equal(oneRule.tempUnschedulableOverloadMinutes, 3);
  assert.deepEqual(schedulingCredentials(oneRule).temp_unschedulable_rules.map(rule => rule.error_code), [429]);
  assert.equal(normalizeSchedulingSettings({ openaiOverloadCooldownMinutes: 0 }).openaiOverloadCooldownMinutes, 10);
  assert.throws(() => normalizeSchedulingSettings({ ...settings, tempUnschedulableRateLimitMinutes: 0 }), /正整数/);
});

test('server exports include typed scheduling credentials without changing auth or runtime state', () => {
  const account = buildSub2ApiAccount(record, settings);
  const policy = schedulingCredentials(settings);
  for (const [key, value] of Object.entries(policy)) assert.deepEqual(account.credentials[key], value);
  assert.equal(account.credentials.access_token, record.access_token);
  assert.ok(account.credentials.model_mapping);
  assert.equal(account.overload_until, undefined);
  assert.equal(account.temp_unschedulable_until, undefined);
  assert.equal(account.extra.openai_overload_cooldown_enabled, undefined);
});

test('new-account reconciliation detects each policy mismatch; credentials-only reconciliation preserves remote policy', async () => {
  const account = buildSub2ApiAccount(record, settings);
  const client = new Sub2ApiClient('https://fixture.invalid', 'fixture-admin-key');
  let row;
  client.matchingAccounts = async () => [row];
  for (const change of [
    credentials => { credentials.openai_overload_cooldown_enabled = false; },
    credentials => { credentials.openai_overload_cooldown_minutes = 10; },
    credentials => { credentials.temp_unschedulable_enabled = false; },
    credentials => { credentials.temp_unschedulable_rules[0].duration_minutes = 10; },
    credentials => { credentials.temp_unschedulable_rules[0].scope = 'model'; },
    credentials => { credentials.temp_unschedulable_rules[0].keywords = ['other']; },
    credentials => { credentials.temp_unschedulable_rules = [null]; },
  ]) {
    row = { ...structuredClone(account), id: 7 };
    change(row.credentials);
    assert.equal((await client.reconcileAccount(account, [7])).code, 'REMOTE_SETTINGS_UNCONFIRMED');
    assert.equal((await client.reconcileAccount(account, [7], { credentialsOnly: true })).status, 'success');
  }
  assert.equal(schedulingCredentialsMatch(account.credentials, account.credentials), true);
});

test('upsert retains remote protection settings, while a new account sends the configured policy', async () => {
  const account = buildSub2ApiAccount(record, settings);
  const oldPolicy = schedulingCredentials({ tempUnschedulableEnabled: true, openaiOverloadCooldownMinutes: 1 });
  const row = { ...structuredClone(account), id: 7, credentials: { ...account.credentials, ...oldPolicy, access_token: 'fixture-old-access' } };
  const client = new Sub2ApiClient('https://fixture.invalid', 'fixture-admin-key');
  const writes = [];
  client.matchingAccounts = async () => [row];
  client.request = async (method, route, body) => { writes.push({ method, route, body }); return { success: 1, results: [{ success: true, id: 8 }] }; };
  await client.upsertAccount(account, [7]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PUT');
  assert.equal(writes[0].body.credentials.access_token, record.access_token);
  for (const [key, value] of Object.entries(oldPolicy)) assert.deepEqual(writes[0].body.credentials[key], value);
  client.matchingAccounts = async () => [];
  client.upsertRows = [];
  await client.upsertAccount(account, [7]);
  assert.equal(writes[1].route, 'accounts/batch');
  for (const [key, value] of Object.entries(schedulingCredentials(settings))) assert.deepEqual(writes[1].body.accounts[0].credentials[key], value);
});
