import { withSessionTransport } from './session-network.js';
import { runAccountTask } from '../login-service/lib/task-concurrency.js';

export const EVALUATION_QUESTIONS = {
  candy: '在一个黑色的袋子里放有三种口味的馒头，每种馒头有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。数量如下：\n形状 | 苹果味 | 桃子味 | 西瓜味\n圆形 | 7 | 9 | 8\n五角星形 | 7 | 6 | 4\n参赛者需要在活动前决定摸出的馒头数目，那么最少取出多少个才能保证手中同时拥有不同形状的苹果味和桃子味馒头？圆形苹果配五角星桃子，或者圆形桃子配五角星苹果，都满足要求。帮我做一下，不调用任何工具、不联网、不要读取本地文件。请解释理由，最后单独一行写“答案：数字”。',
  pelican: '创建一个HTML，内容是用SVG绘制一个鹈鹕骑自行车的2D动画，你不能进行任何测试，不能调用skills，不能网络检索，不能调用子智能体，直接生成。\n只输出一个可独立打开的完整HTML文件，不要解释或Markdown围栏。用内联SVG和CSS/SMIL实现循环动画，保留可辨认的鹈鹕、大嘴、双轮自行车和踩踏动作。代码尽量控制在120行、6000字符以内，使用defs/use复用图形，避免复杂背景、装饰和重复路径；无需JavaScript和外部资源。',
};

export function validateEvaluation(body = {}) {
  const { account, question, model = 'gpt-6-astra' } = body;
  if (!Object.hasOwn(EVALUATION_QUESTIONS, question) || typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)
    || typeof account?.accessToken !== 'string' || !account.accessToken.trim() || account.accessToken.length > 32768 || /[\r\n]/.test(account.accessToken)
    || (account.accountId != null && (typeof account.accountId !== 'string' || account.accountId.length > 200 || /[\r\n]/.test(account.accountId)))) {
    throw Object.assign(new Error('请提供有效账号、模型和测试题'), { statusCode: 400 });
  }
  return { account, question, model };
}

export function parseEvaluationResponse(text) {
  let completed;
  let deltas = '';
  if (text.trim().startsWith('{')) {
    completed = JSON.parse(text);
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('模型返回失败或不完整的结果');
      if (event.type === 'response.output_text.delta') deltas += event.delta || '';
      if (event.type === 'response.completed') completed = event.response;
    }
  }
  if (!completed || completed.error || completed.status && completed.status !== 'completed') throw new Error('模型响应未完成');
  const output = (completed.output || []).flatMap(item => item.type === 'message' ? item.content || [] : [])
    .filter(item => item.type === 'output_text').map(item => item.text || '').join('') || completed.output_text || deltas;
  if (!output.trim()) throw new Error('模型未返回文本');
  return output;
}

export function gradeEvaluation(question, output) {
  if (question === 'candy') {
    const answer = output.trim().match(/(?:^|\n)\s*(?:\*\*)?答案\s*[:：]\s*(\d+)(?:\*\*)?\s*[。.]?\s*$/)?.[1];
    return { status: answer ? (answer === '21' ? 'passed' : 'wrong_answer') : 'invalid_format', answer: answer || '' };
  }
  const html = output.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
  return { status: /<html\b/i.test(html) && /<\/html>/i.test(html) && /<svg\b/i.test(html) ? 'manual_review' : 'invalid_format', html };
}

export async function evaluateModel(body, { signal, fetchImpl } = {}) {
  const { account, question, model } = validateEvaluation(body);
  const started = Date.now();
  const run = async ({ fetchImpl, signal }) => {
    const response = await fetchImpl('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', redirect: 'manual', timeout: 120,
      signal: AbortSignal.any([AbortSignal.timeout(125_000), signal].filter(Boolean)),
      headers: { Authorization: `Bearer ${account.accessToken.trim()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
        ...(account.accountId ? { 'ChatGPT-Account-Id': account.accountId } : {}) },
      body: JSON.stringify({ model, stream: true, store: false, instructions: "Follow the user's request. No tools are available.",
        input: [{ role: 'user', content: [{ type: 'input_text', text: EVALUATION_QUESTIONS[question] }] }], reasoning: { effort: 'medium' } }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`模型请求失败（HTTP ${response.status}）`); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('模型响应过大');
    const output = parseEvaluationResponse(text);
    return { model, question, output, ...gradeEvaluation(question, output), durationMs: Date.now() - started };
  };
  return fetchImpl ? run({ fetchImpl, signal }) : runAccountTask(() => withSessionTransport(run, { signal }), { signal });
}
