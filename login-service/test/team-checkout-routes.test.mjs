import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, installErrorHandlers } from '../src/app/create-app.js';
import { browserRequestMiddleware } from '../src/services/browser-request-context.js';
import { registerTeamCheckoutRoutes } from '../src/api/routes/team-checkout-routes.js';
import { generateTeamCheckout } from '../src/services/team-checkout.js';

async function fixture(context, generateCheckout, logger) {
  const app = createApp();
  app.use(browserRequestMiddleware({ strictRoutes: true, createRuntime: () => assert.fail('checkout must not allocate account storage') }));
  registerTeamCheckoutRoutes(app, { generateCheckout, logger });
  installErrorHandlers(app);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  context.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v2/team/checkout';
  return body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('checkout route passes strict routing and returns a non-cacheable result without account state', async context => {
  const post = await fixture(context, (body, options) => generateTeamCheckout(body, { ...options, fetchImpl: async () => Response.json({ url: 'https://pay.openai.com/c/pay/fixture' }) }));
  const response = await post({ accessToken: 'fixture-token', workspaceName: 'Team' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://pay.openai.com/c/pay/fixture');
  assert.equal(result.workspaceName, 'Team');
  assert.doesNotMatch(JSON.stringify(result), /fixture-token|browserState/);
});

test('checkout route returns parameter failures and hides unexpected error details', async context => {
  const post = await fixture(context, generateTeamCheckout);
  const response = await post({ workspaceName: 'Team' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_TEAM_CHECKOUT');
  const brokenPost = await fixture(context, async () => { throw new Error('private-secret'); });
  const broken = await brokenPost({});
  assert.equal(broken.status, 500);
  assert.doesNotMatch(await broken.text(), /private-secret/);
});

test('checkout route normalizes a wrapped JWT before sending its Authorization header through a proxy', async context => {
  const token = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
    + '.' + Buffer.from(JSON.stringify({ sub: 'fixture-user' })).toString('base64url') + '.fixture-signature';
  const post = await fixture(context, (body, options) => generateTeamCheckout(body, {
    ...options,
    createProxyFetch: proxyUrl => {
      assert.equal(proxyUrl, 'http://user:password@proxy.example:8080/');
      const transport = async (_endpoint, request) => {
        assert.equal(request.headers.Authorization, 'Bearer ' + token);
        return Response.json({ url: 'https://pay.openai.com/c/pay/fixture' });
      };
      transport.dispose = async () => {};
      return transport;
    },
  }));
  const response = await post({ accessToken: 'Bearer ' + token.match(/.{1,24}/g).join('\n'), workspaceName: 'Team', proxyMode: 'custom', proxyUrl: 'proxy.example:8080:user:password' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.doesNotMatch(JSON.stringify(body), /fixture-signature|password/);
});

test('checkout route logs only allowlisted diagnostic metadata and returns the same safe fields', async context => {
  const logs = [];
  const post = await fixture(context, async () => {
    throw Object.assign(new Error('支付服务返回访问验证页面（HTTP 403）'), {
      status: 403, code: 'CHECKOUT_REJECTED',
      diagnostics: { category: 'edge_challenge', upstreamStatus: 403, responseFormat: 'html', edgeChallenge: true, authorizationPresent: true, accessToken: 'private-token', proxyUrl: 'http://private-user:private-password@proxy.example:8080', rawBody: 'private-response', upstreamCode: 'private-code' },
    });
  }, { warn: text => logs.push(text) });
  const response = await post({});
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.deepEqual(body.diagnostics, { category: 'edge_challenge', upstreamStatus: 403, responseFormat: 'html', edgeChallenge: true, authorizationPresent: true });
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).event, 'team_checkout_failed');
  assert.doesNotMatch(JSON.stringify(body) + logs.join(''), /private-token|private-user|private-password|private-response|private-code|proxy.example/);
});
