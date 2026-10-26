const TITLES = { candy: '糖果题（参考摸馒头）', pelican: '鹈鹕骑自行车' };
const STATUS = { queued: '排队中', running: '测试中', passed: '答案正确（21）', wrong_answer: '答案错误', invalid_format: '格式不完整', manual_review: '待人工评审', error: '请求失败', cancelled: '已停止' };

export function initializeModelEvaluation({ request, getAccounts, getHeaders, isWorkspaceCurrent }) {
  const panel = document.querySelector('#model-evaluation');
  if (!panel) return { reset() {}, refresh() {} };
  const start = panel.querySelector('[data-evaluation-start]');
  const stop = panel.querySelector('[data-evaluation-stop]');
  const model = panel.querySelector('input');
  const status = panel.querySelector('[role=status]');
  const results = panel.querySelector('[data-evaluation-results]');
  let controller;
  let generation = 0;
  const refresh = () => { start.disabled = Boolean(controller) || !getAccounts().length; };
  const reset = () => {
    generation++;
    controller?.abort();
    controller = null;
    results.replaceChildren();
    status.textContent = '每个转换账号测试两题；糖果题沿用参考项目的摸馒头题，预期答案 21。';
    stop.disabled = true;
    model.disabled = false;
    refresh();
  };
  stop.addEventListener('click', () => controller?.abort());
  start.addEventListener('click', async () => {
    if (controller) return;
    const chosenModel = model.value.trim();
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(chosenModel)) { status.textContent = '请选择或输入有效模型名称。'; return; }
    const accounts = getAccounts();
    if (!accounts.length) return;
    const current = new AbortController();
    controller = current;
    const run = ++generation;
    const isCurrent = isWorkspaceCurrent(current.signal);
    const active = () => run === generation && isCurrent();
    results.replaceChildren();
    model.disabled = true;
    stop.disabled = false;
    refresh();
    let done = 0;
    const jobs = accounts.flatMap((account, index) => Object.keys(TITLES).map(question => {
      const row = document.createElement('details');
      const summary = document.createElement('summary');
      const label = `${account.email || `账号 ${index + 1}`} · ${TITLES[question]}`;
      summary.textContent = `${label} · 排队中`;
      row.append(summary);
      results.append(row);
      return { account, question, row, summary, label, status: 'queued' };
    }));
    let cursor = 0;
    status.textContent = `正在测试 ${accounts.length} 个账号 · ${chosenModel} · 0/${jobs.length}`;
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
      while (cursor < jobs.length && active()) {
        const job = jobs[cursor++];
        job.status = 'running';
        job.summary.textContent = `${job.label} · 测试中`;
        try {
          const response = await request('/api/model-evaluation', {
            method: 'POST', credentials: 'same-origin', signal: current.signal,
            headers: getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ account: job.account, model: chosenModel, question: job.question }),
          });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(typeof result.error === 'string' ? result.error : `HTTP ${response.status}`);
          if (!active()) return;
          job.status = result.status;
          job.summary.textContent = `${job.label} · ${STATUS[result.status] || result.status} · ${(result.durationMs / 1000).toFixed(1)}s`;
          const output = document.createElement('pre');
          output.textContent = result.output;
          job.row.append(output);
          if (job.question === 'pelican' && result.status === 'manual_review') {
            const preview = document.createElement('button');
            preview.type = 'button';
            preview.className = 'button button-secondary';
            preview.textContent = '预览鹈鹕动画';
            preview.addEventListener('click', () => {
              const frame = document.createElement('iframe');
              frame.title = `${job.label} 动画预览`;
              frame.setAttribute('sandbox', '');
              frame.referrerPolicy = 'no-referrer';
              // The injected policy blocks network access even for untrusted model HTML.
              frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">${result.html}`;
              preview.replaceWith(frame);
            }, { once: true });
            job.row.append(preview);
          }
        } catch (error) {
          if (!active()) return;
          job.status = 'error';
          job.summary.textContent = `${job.label} · 请求失败`;
          const message = document.createElement('p');
          message.textContent = error.message;
          job.row.append(message);
        }
        done++;
        if (active()) status.textContent = `测试进度 ${done}/${jobs.length} · ${chosenModel}`;
      }
    }));
    if (run !== generation) return;
    for (const job of jobs) {
      if (['queued', 'running'].includes(job.status)) {
        job.status = 'cancelled';
        job.summary.textContent = `${job.label} · 已停止`;
      }
    }
    status.textContent = `${current.signal.aborted ? '已停止' : '测试完成'}：${done}/${jobs.length} · 答案正确 ${jobs.filter(j => j.status === 'passed').length} · 待评审 ${jobs.filter(j => j.status === 'manual_review').length} · 失败 ${jobs.filter(j => ['error', 'wrong_answer', 'invalid_format'].includes(j.status)).length} · ${chosenModel}`;
    controller = null;
    stop.disabled = true;
    model.disabled = false;
    refresh();
  });
  return { reset, refresh };
}
