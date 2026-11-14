// Usage: node mcp-drive.mjs 'tool:{"json":"args"}' ['tool2:{...}' ...]
// One MCP connection per run; executes tools in order, prints each result.
// chrome://inspect remote-debugging must be enabled; click Allow on Chrome's dialog.
import { spawn } from 'node:child_process';

const steps = process.argv.slice(2).map((a) => {
  const idx = a.indexOf(':');
  const name = idx < 0 ? a : a.slice(0, idx);
  const args = idx < 0 ? {} : JSON.parse(a.slice(idx + 1));
  return { name, args };
});

const proc = spawn('node', ['node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js', '--autoConnect', '--channel=stable'], {
  cwd: import.meta.dirname,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
let id = 0;

proc.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[mcp-err] ' + d));

const send = (method, params) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });

const notify = (method) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

const init = await send('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: { roots: { listChanged: false } },
  clientInfo: { name: 'career-ops', version: '0.1.0' },
});
notify('notifications/initialized');
if (!init?.result?.serverInfo) {
  console.error('handshake failed');
  process.exit(1);
}

for (const step of steps) {
  const res = await send('tools/call', { name: step.name, arguments: step.args });
  console.log(`\n=== ${step.name} ===`);
  if (res.result?.isError) console.log('ERROR:');
  if (res.result?.content) {
    for (const c of res.result.content) console.log(c.type === 'text' ? c.text : '[' + c.type + ' content]');
  } else {
    console.log(JSON.stringify(res).slice(0, 800));
  }
}

proc.kill('SIGTERM');
process.exit(0);
