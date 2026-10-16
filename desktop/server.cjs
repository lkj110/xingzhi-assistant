// Local browser preview / integration test transport. Desktop uses isolated IPC instead.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Assistant } = require('./core.cjs');

function startServer({ dir = process.env.ASSISTANT_DATA_DIR || path.join(__dirname, '../.local-data'), port = Number(process.env.PORT || 4317), chat } = {}) {
  const assistant = new Assistant({ dir, chat });
  const token = crypto.randomBytes(32).toString('hex');
  const session = crypto.randomBytes(32).toString('hex');
  let origin;
  const respond = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== new URL(origin).host) return respond(res, 403, { error: 'Invalid host' });
    const url = new URL(req.url, origin);
    if (req.headers.origin && req.headers.origin !== origin) return respond(res, 403, { error: 'Invalid origin' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return respond(res, 403, { error: 'Cross-site access denied' });
    if (url.pathname === '/api/session' && req.method === 'GET') {
      res.setHeader('Set-Cookie', `assistant=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return respond(res, 200, { token });
    }
    if (url.pathname === '/api/call' && req.method === 'POST') {
      if (req.headers['x-assistant-token'] !== token || !req.headers.cookie?.split(';').map(s => s.trim()).includes(`assistant=${session}`)) return respond(res, 403, { error: 'Session required' });
      try {
        const chunks = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > 36_000_000) throw new Error('请求内容超过 36 MB，请分批提交材料'); chunks.push(part); }
        const { action, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return respond(res, 200, { data: await assistant.dispatch(action, input) });
      } catch (error) { return respond(res, 400, { error: error.message }); }
    }
    if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
    const root = path.resolve(__dirname, '../dist');
    let requested;
    try { requested = decodeURIComponent(url.pathname); } catch { return respond(res, 400, { error: 'Invalid path' }); }
    const file = path.resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return respond(res, 404, { error: 'Not found' });
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' }); fs.createReadStream(file).pipe(res);
  });
  const timer = setInterval(() => assistant.tick(), 15000); timer.unref();
  server.on('close', () => { clearInterval(timer); require('./execution.cjs').abortAll(assistant); });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, assistant, origin });
  }));
}
if (require.main === module) startServer().then(({ origin }) => process.stdout.write(`行知助手本地预览：${origin}\n`));
module.exports = { startServer };
