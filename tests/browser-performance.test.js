import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + '\n  }'.length);
}

function savingHarness() {
  const timers = new Map(), writes = [];
  let sequence = 0, snapshots = 0, release;
  const state = { value: 0, loginProgress: new Map() };
  const context = vm.createContext({
    browserStorageReady: true, browserStorageCleared: false, browserSaveTimer: null, browserSaveInFlight: null,
    state, elements: { loginResetCredentials: { textContent: '' } },
    workspaceTaskIsCurrent: () => () => !context.browserStorageCleared,
    browserFields: () => [], document: { querySelector: () => ({ textContent: '' }) },
    scheduleSessionMonitor: () => {},
    setTimeout: callback => { timers.set(++sequence, callback); return sequence; },
    clearTimeout: id => timers.delete(id),
    workspaceSchema: { serialize: ({ state: current }) => { snapshots++; return { value: current.value }; } },
    window: { browserWorkspace: { save: (snapshot, options) => {
      writes.push({ ...snapshot, ...options });
      return writes.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    } } },
  });
  vm.runInContext(functionSource('persistBrowserWorkspace'), context);
  return { context, state, writes, timers, snapshots: () => snapshots, release: () => release(),
    tick: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test('slow browser saves build only the active snapshot and the latest pending state', async () => {
  const h = savingHarness();
  h.context.persistBrowserWorkspace(); h.tick();
  for (let index = 1; index <= 30; index++) {
    h.state.value = index;
    h.context.persistBrowserWorkspace(); h.tick();
  }
  assert.equal(h.snapshots(), 1, 'superseded updates must not serialize the workspace');
  h.release();
  await new Promise(setImmediate);
  assert.equal(h.timers.size, 1);
  h.tick();
  await new Promise(setImmediate);
  assert.deepEqual(h.writes.map(write => write.value), [0, 30]);
  assert.equal(h.snapshots(), 2);
});

test('required saves capture credentials immediately while ordinary work waits', async () => {
  const h = savingHarness();
  h.context.persistBrowserWorkspace(); h.tick();
  h.state.value = 1;
  h.context.persistBrowserWorkspace(); h.tick();
  h.state.value = 2;
  await h.context.persistBrowserWorkspace(true, true);
  assert.deepEqual(h.writes[1], { value: 2, barrier: true });
  h.state.value = 3;
  h.release(); await new Promise(setImmediate); h.tick(); await new Promise(setImmediate);
  assert.deepEqual(h.writes.map(write => write.value), [0, 2, 3]);
});

test('clearing during a slow save prevents delayed state from being written back', async () => {
  const h = savingHarness();
  h.context.persistBrowserWorkspace(); h.tick();
  h.state.value = 1;
  h.context.persistBrowserWorkspace(); h.tick();
  h.context.browserStorageCleared = true;
  h.release(); await new Promise(setImmediate); h.tick();
  assert.equal(h.snapshots(), 1);
  assert.equal(h.writes.length, 1);
});

test('progress events with an email find the account without scanning the batch', () => {
  const record = { id: 'last', email: 'last@example.test' };
  const records = new Map([['last@example.test', record]]);
  records.values = () => assert.fail('email events must use the index');
  const context = vm.createContext({ state: { loginProgress: records } });
  vm.runInContext(functionSource('loginProgressRecord'), context);
  assert.equal(context.loginProgressRecord({ email: 'LAST@example.test' }), record);
});

test('lease heartbeats omit token and workspace payloads but keep credential version identity', async () => {
  const bodies = [];
  const context = vm.createContext({ fetch: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  vm.runInContext(functionSource('monitorLeaseRequest'), context);
  const account = { id: 'a', email: 'a@example.test', openai_password: 'new', password: 'old', twoFactorSecret: 'totp',
    session_access_token: 'x'.repeat(10000), business_workspace_credentials: [{ accessToken: 'unused' }] };
  await context.monitorLeaseRequest([account], 'owner');
  assert.deepEqual(bodies[0].browserState.accounts, [{ id: 'a', email: 'a@example.test', password: 'new', two_factor_secret: 'totp' }]);
  assert.ok(JSON.stringify(bodies[0]).length < JSON.stringify(account).length / 10);
  await context.monitorLeaseRequest([account], 'owner', 'release');
  assert.deepEqual(bodies[1].browserState.accounts, [{ id: 'a', email: 'a@example.test' }]);
});
