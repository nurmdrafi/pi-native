// Persistent MCP bridge: one chrome-devtools-mcp connection for the whole
// session = ONE Chrome Allow-dialog. Line-JSON protocol over a unix socket.
// Start: nohup node mcp-bridge.mjs >/tmp/mcp-bridge.log 2>&1 &
// Query: node mcp-client.mjs 'tool:{"json":"args"}' ...
// Stop:  node mcp-client.mjs __quit__   (banner in Chrome disappears)
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const SOCK = path.join(import.meta.dirname, 'bridge.sock');
const BIN = path.join(import.meta.dirname, 'node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js');

let proc, buf = '', id = 0;
const pending = new Map();

function startServer() {
  proc = spawn('node', [BIN, '--autoConnect', '--channel=stable'], { stdio: ['pipe', 'pipe', 'pipe'] });
  buf = '';
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', (d) => fs.appendFileSync('/tmp/mcp-bridge.err', d));
  proc.on('exit', () => { for (const r of pending.values()) r({ error: 'mcp-server-exited' }); pending.clear(); });
}

function onChunk(d) {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
}

const send = (method, params) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
});

async function ensureInit() {
  if (!proc || proc.exitCode !== null) startServer();
  if (!ensureInit.done) {
    const init = await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'career-ops-bridge', version: '0.1.0' },
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    if (!init?.result?.serverInfo) throw new Error('handshake failed');
    ensureInit.done = true;
  }
}

async function callTool(name, args) {
  await ensureInit();
  const res = await send('tools/call', { name, arguments: args });
  if (res.error) return { error: res.error.message };
  const text = (res.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { isError: !!res.result?.isError, text };
}

try { fs.unlinkSync(SOCK); } catch {}
const server = net.createServer((conn) => {
  conn.setEncoding('utf8');
  let cbuf = '';
  conn.on('data', async (chunk) => {
    cbuf += chunk;
    let nl;
    while ((nl = cbuf.indexOf('\n')) >= 0) {
      const line = cbuf.slice(0, nl).trim();
      cbuf = cbuf.slice(nl + 1);
      if (!line) continue;
      if (line === '__quit__') { conn.write(JSON.stringify({ ok: true }) + '\n'); server.close(); proc?.kill('SIGTERM'); process.exit(0); }
      let reply;
      try {
        const req = JSON.parse(line); // {tool, args}
        reply = await callTool(req.tool, req.args || {});
      } catch (e) { reply = { error: String(e.message || e) }; }
      conn.write(JSON.stringify(reply) + '\n');
    }
  });
});
server.listen(SOCK, () => fs.chmodSync(SOCK, 0o600));
console.log('bridge listening on', SOCK);
