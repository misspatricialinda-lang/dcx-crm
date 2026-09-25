function answerFromJson(data) {
  const value = Array.isArray(data) ? data[0] : data;
  const answer = value?.output ?? value?.text ?? value?.message ?? value?.content;
  return typeof answer === 'string' ? answer : null;
}

export function parseCalendarResponse(raw) {
  try {
    const data = JSON.parse(raw);
    const answer = answerFromJson(data);
    if (answer !== null) return answer;
  } catch { /* n8n streaming responses contain multiple JSON records. */ }

  const chunks = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (payload === '[DONE]') continue;
    let event;
    try { event = JSON.parse(payload); } catch { return null; }
    if (event?.type === 'item' && typeof event.content === 'string') chunks.push(event.content);
  }
  return chunks.length ? chunks.join('') : null;
}
