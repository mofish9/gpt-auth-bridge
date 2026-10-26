import { evaluateModel, validateEvaluation } from './model-evaluation.js';

export async function streamModelEvaluation(body, response, { evaluate = evaluateModel } = {}) {
  try { validateEvaluation(body); }
  catch (error) {
    response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: false, error: error.message }));
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once('close', cancel);
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' });
  response.flushHeaders();
  const emit = event => {
    if (!response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15_000);
  try {
    const result = await evaluate(body, { signal: controller.signal, onEvent: emit });
    emit({ type: 'complete', ...result });
  } catch (error) {
    const safeMessage = /^模型/.test(error.message) ? error.message : '请求失败或超时，请检查账号、API 地址和网络后重试';
    emit({ type: 'error', error: safeMessage });
  } finally {
    clearInterval(heartbeat);
    response.off('close', cancel);
    response.end();
  }
}
