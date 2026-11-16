// Client for mcp-bridge.mjs. Usage: node mcp-client.mjs 'tool:{"json":"args"}' ...
// Special: __quit__ stops the bridge (drops the Chrome debug session + banner).
import net from 'node:net';
import path from 'node:path';

const SOCK = path.join(import.meta.dirname, 'bridge.sock');
const reqs = process.argv.slice(2).map((a) => {
  if (a === '__quit__') return { quit: true };
  const i = a.indexOf(':');
  return { tool: i < 0 ? a : a.slice(0, i), args: i < 0 ? {} : JSON.parse(a.slice(i + 1)) };
});

const conn = net.createConnection(SOCK);
conn.setEncoding('utf8');
let buf = '';
let idx = 0;

const step = () => {
  if (idx >= reqs.length) { conn.end(); process.exit(0); }
  const r = reqs[idx++];
  conn.write((r.quit ? '__quit__' : JSON.stringify(r)) + '\n');
};

conn.on('connect', step);
conn.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const res = JSON.parse(line);
      console.log(res.isError ? 'ERROR: ' + res.text : res.error ? 'ERROR: ' + res.error : res.text);
    } catch { console.log(line); }
    step();
  }
});
conn.on('error', (e) => { console.error('bridge not reachable:', e.code, '- start with: nohup node ~/.pi/agent/extensions/chrome-devtools-mcp/mcp-bridge.mjs >/tmp/mcp-bridge.log 2>&1 &'); process.exit(1); });
setTimeout(() => { console.error('bridge timeout'); process.exit(1); }, 110000);
