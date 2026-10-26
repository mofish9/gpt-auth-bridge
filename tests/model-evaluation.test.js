import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateModel, parseEvaluationResponse, gradeEvaluation, validateEvaluation } from '../src/model-evaluation.js';

const account = { accessToken: 'fixture-token', accountId: 'workspace-one' };
const completed = output => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] });

test('evaluation forwards chosen model and workspace to the fixed endpoint', async () => {
  for (const model of ['gpt-6-astra', 'custom-model']) {
    const result = await evaluateModel({ account, question: 'candy', model }, { fetchImpl: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.headers['ChatGPT-Account-Id'], 'workspace-one');
      assert.equal(init.headers.Authorization, 'Bearer fixture-token');
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.match(body.input[0].content[0].text, /五角星/);
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: completed('推理过程\n答案：21') })}\n\n`);
    } });
    assert.equal(result.status, 'passed');
    assert.equal(result.model, model);
    assert.ok(!JSON.stringify(result).includes('fixture-token'));
  }
  assert.equal(validateEvaluation({ account, question: 'pelican' }).model, 'gpt-6-astra');
});

test('grading requires the final answer and leaves valid HTML for human review', () => {
  assert.equal(gradeEvaluation('candy', '考虑 21 种情况\n答案：22').status, 'wrong_answer');
  assert.equal(gradeEvaluation('candy', '可能是21').status, 'invalid_format');
  assert.equal(gradeEvaluation('pelican', '<html><svg></svg></html>').status, 'manual_review');
  assert.equal(gradeEvaluation('pelican', '<svg>').status, 'invalid_format');
});

test('stream parser rejects truncated and failed streams without grading partial answers', () => {
  assert.throws(() => parseEvaluationResponse('data: {"type":"response.output_text.delta","delta":"答案：21"}\n\n'), /未完成/);
  for (const type of ['error', 'response.failed', 'response.incomplete']) {
    assert.throws(() => parseEvaluationResponse(`data: ${JSON.stringify({ type })}\n\n`), /不完整/);
  }
  assert.equal(parseEvaluationResponse(JSON.stringify(completed('答案：21'))), '答案：21');
});

test('invalid credentials, question and model are rejected before any request', () => {
  for (const body of [{ account, question: '__proto__' }, { account, question: 'candy', model: '' },
    { account: { accessToken: 'x\r\ny' }, question: 'candy' }, { question: 'candy' }]) {
    assert.throws(() => validateEvaluation(body), { statusCode: 400 });
  }
});

test('upstream failure does not reflect response contents or credentials', async () => {
  await assert.rejects(evaluateModel({ account, question: 'candy' }, {
    fetchImpl: async () => new Response('fixture-token secret', { status: 401 }),
  }), { message: '模型请求失败（HTTP 401）' });
});
