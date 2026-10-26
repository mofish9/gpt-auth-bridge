// Shared by the browser and server: SSE frames can span arbitrary UTF-8 chunks.
export async function readEvaluationEvents(body, onEvent) {
  if (!body) throw new Error('响应没有数据流');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  const consume = async frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    await onEvent(data === '[DONE]' ? { type: 'done' } : JSON.parse(data));
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      bytes += value?.byteLength || 0;
      if (bytes > 4 * 1024 * 1024) throw new Error('模型响应过大');
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Keep a trailing CR until the next chunk arrives.
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        await consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
      if (buffer.length > 1024 * 1024) throw new Error('模型响应帧过大');
      if (done) { if (buffer.trim()) await consume(buffer); break; }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
