// Talks to the dev server. Turns stream back as server-sent events over a POST, so this reads the body by hand.

export async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status} ${r.statusText}`);
  return r.json();
}

export async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status} ${r.statusText}`);
  return r.json();
}

/** POSTs and calls onEvent(name, data) for each event until the stream ends. */
export async function stream(path, body, onEvent) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status} ${r.statusText}`);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = chunk.match(/^event: (.*)$/m)?.[1];
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (event) onEvent(event, data ? JSON.parse(data) : null);
    }
  }
}
