// Minimal fake req/res so we can exercise the actual handler modules
// (imported unmodified from api/) without spinning up a real server.
import { EventEmitter } from 'node:events';

export function makeReq({ method = 'POST', url = '/', headers = {}, body = '' }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

export function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(obj) { this.headers['content-type'] = 'application/json'; this.body = JSON.stringify(obj); this._json = obj; return this; },
  };
  return res;
}
