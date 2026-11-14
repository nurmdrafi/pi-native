import { spawn } from 'node:child_process';

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
  capabilities: {},
  clientInfo: { name: 'career-ops-probe', version: '0.1.0' },
});
notify('notifications/initialized');
console.log('server:', init?.result?.serverInfo?.name, init?.result?.serverInfo?.version);

const tools = await send('tools/list', {});
console.log('tools(' + tools.result.tools.length + '):', tools.result.tools.map((t) => t.name).join(', '));

proc.kill('SIGTERM');
process.exit(0);
