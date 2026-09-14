// Exercises the real api/openai/realtime-webhook.js handler against:
//  1. A correctly signed realtime.call.incoming event -> verifies signature,
//     calls the (mocked) OpenAI accept endpoint with the right payload,
//     and returns 200.
//  2. An invalid signature -> expect 400, and the accept endpoint must
//     NOT be called.
//  3. A missing webhook-signature header -> expect 400.
//  4. A validly-signed event of a type we don't handle -> expect 200
//     (acknowledged, ignored) without calling accept.
//  5. Non-POST method -> expect 405.
//
// Implements the Standard Webhooks signing scheme independently (rather
// than reusing the SDK's internal signer) so this is a real black-box
// test of compatibility, not a tautology.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeReq, makeRes } from './harness.js';

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('a-fake-signing-secret-32-bytes!!').toString('base64');
process.env.OPENAI_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.OPENAI_API_KEY = 'sk-test-fake-key-not-real';

const handlerModule = await import('../api/openai/realtime-webhook.js');
const handler = handlerModule.default;

function sign(secret, webhookId, timestamp, payload) {
  const decodedSecret = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
  const signedPayload = `${webhookId}.${timestamp}.${payload}`;
  const sig = crypto.createHmac('sha256', decodedSecret).update(signedPayload).digest('base64');
  return `v1,${sig}`;
}

function eventPayload(overrides = {}) {
  return JSON.stringify({
    object: 'event',
    id: 'evt_test_123',
    type: 'realtime.call.incoming',
    created_at: Math.floor(Date.now() / 1000),
    data: { call_id: 'rtc_test_call_id_123', sip_headers: [] },
    ...overrides,
  });
}

function run(name, fn) {
  return fn()
    .then(() => console.log(`PASS  ${name}`))
    .catch((err) => {
      console.error(`FAIL  ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

const realFetch = globalThis.fetch;
function mockFetch(impl) {
  globalThis.fetch = async (...args) => impl(...args);
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

await run('valid signature + realtime.call.incoming -> 200, calls accept with correct payload', async () => {
  const payload = eventPayload();
  const webhookId = 'msg_test_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(WEBHOOK_SECRET, webhookId, timestamp, payload);

  let acceptCall = null;
  mockFetch(async (url, opts) => {
    acceptCall = { url: String(url), opts };
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });

  const req = makeReq({
    url: '/api/openai/realtime-webhook',
    headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
    body: payload,
  });
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    restoreFetch();
  }

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.ok(acceptCall, 'expected the accept endpoint to be called');
  assert.equal(acceptCall.url, 'https://api.openai.com/v1/realtime/calls/rtc_test_call_id_123/accept');
  assert.equal(acceptCall.opts.headers.Authorization, 'Bearer sk-test-fake-key-not-real');
  const sentBody = JSON.parse(acceptCall.opts.body);
  assert.equal(sentBody.type, 'realtime');
  assert.equal(sentBody.model, 'gpt-realtime-2.1-mini');
  assert.equal(typeof sentBody.instructions, 'string');
  assert.ok(sentBody.instructions.length > 0);
});

await run('invalid signature -> 400, accept endpoint never called', async () => {
  const payload = eventPayload();
  const webhookId = 'msg_test_2';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const badSignature = 'v1,' + Buffer.from('not-a-real-signature').toString('base64');

  let acceptCalled = false;
  mockFetch(async () => {
    acceptCalled = true;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });

  const req = makeReq({
    url: '/api/openai/realtime-webhook',
    headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': badSignature },
    body: payload,
  });
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    restoreFetch();
  }

  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
  assert.equal(acceptCalled, false, 'accept endpoint must not be called on invalid signature');
});

await run('missing webhook-signature header -> 400', async () => {
  const payload = eventPayload();
  const req = makeReq({
    url: '/api/openai/realtime-webhook',
    headers: { 'webhook-id': 'msg_test_3', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)) },
    body: payload,
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
});

await run('valid signature but unhandled event type -> 200, accept never called', async () => {
  const payload = eventPayload({ type: 'response.completed', data: { id: 'resp_123' } });
  const webhookId = 'msg_test_4';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(WEBHOOK_SECRET, webhookId, timestamp, payload);

  let acceptCalled = false;
  mockFetch(async () => {
    acceptCalled = true;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });

  const req = makeReq({
    url: '/api/openai/realtime-webhook',
    headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
    body: payload,
  });
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    restoreFetch();
  }

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.equal(acceptCalled, false, 'accept endpoint must not be called for unrelated event types');
});

await run('valid signature but OpenAI accept call fails -> 502, no crash', async () => {
  const payload = eventPayload({ data: { call_id: 'rtc_will_fail', sip_headers: [] } });
  const webhookId = 'msg_test_5';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(WEBHOOK_SECRET, webhookId, timestamp, payload);

  mockFetch(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'bad request from openai' }));

  const req = makeReq({
    url: '/api/openai/realtime-webhook',
    headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
    body: payload,
  });
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    restoreFetch();
  }

  assert.equal(res.statusCode, 502, `expected 502, got ${res.statusCode}: ${res.body}`);
});

await run('GET -> 405', async () => {
  const req = makeReq({ method: 'GET', url: '/api/openai/realtime-webhook', headers: {}, body: '' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405, `expected 405, got ${res.statusCode}: ${res.body}`);
});

console.log('realtime-webhook tests done');
