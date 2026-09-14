// Exercises the real api/openai/realtime-webhook.js handler against:
//  1. A correctly signed realtime.call.incoming event -> verifies signature,
//     calls the (mocked) OpenAI accept endpoint with the full production
//     session config (Darren's instructions, voice, turn detection, tools),
//     and returns 200.
//  2. An invalid signature -> expect 400, and the accept endpoint must
//     NOT be called.
//  3. A missing webhook-signature header -> expect 400.
//  4. A validly-signed event of a type we don't handle -> expect 200
//     (acknowledged, ignored) without calling accept.
//  5. Non-POST method -> expect 405.
//  6. Accept succeeds but is misconfigured/rejected -> 502, no crash.
//
// CALMCALL_VOICE_TEST_MODE=1 stops the handler from opening a second, real
// WebSocket to OpenAI for the live-call bridge after a successful accept —
// that bridge (api/_lib/call-session.js) is unit-tested on its own in
// test/call-session.test.js against fake events, with no real socket
// involved either. Without this flag these tests would try to open a real
// `wss://api.openai.com` connection using a fake API key.
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
process.env.CALMCALL_VOICE_TEST_MODE = '1';

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

// The openai SDK sends fetch(url, { headers: Headers, body: string }) - a
// real Headers instance, not a plain object - so reads need .get().
function authHeader(opts) {
  return opts.headers.get ? opts.headers.get('Authorization') : opts.headers.Authorization;
}

await run('valid signature + realtime.call.incoming -> 200, accepts with full session config', async () => {
  const payload = eventPayload();
  const webhookId = 'msg_test_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(WEBHOOK_SECRET, webhookId, timestamp, payload);

  let acceptCall = null;
  mockFetch(async (url, opts) => {
    acceptCall = { url: String(url), opts };
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => '' };
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
  assert.equal(authHeader(acceptCall.opts), 'Bearer sk-test-fake-key-not-real');

  const sentBody = JSON.parse(acceptCall.opts.body);
  assert.equal(sentBody.type, 'realtime');
  assert.equal(sentBody.model, 'gpt-realtime-2.1-mini');
  assert.equal(typeof sentBody.instructions, 'string');
  assert.ok(sentBody.instructions.length > 0);
  assert.match(sentBody.instructions, /Darren/);
  assert.match(sentBody.instructions, /British English/);

  // Voice + barge-in configuration.
  assert.equal(sentBody.audio.output.voice, 'cedar');
  assert.equal(sentBody.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(sentBody.audio.input.turn_detection.interrupt_response, true);
  assert.equal(sentBody.audio.input.noise_reduction.type, 'near_field');
  assert.equal(typeof sentBody.audio.input.transcription.model, 'string');

  // Tools: submit_lead and end_call always present; transfer_call only
  // when a transfer target is actually configured (it isn't here).
  const toolNames = sentBody.tools.map((t) => t.name);
  assert.ok(toolNames.includes('submit_lead'));
  assert.ok(toolNames.includes('end_call'));
  assert.ok(!toolNames.includes('transfer_call'), 'transfer_call must not be offered without TRANSFER_TARGET_URI');
});

await run('invalid signature -> 400, accept endpoint never called', async () => {
  const payload = eventPayload();
  const webhookId = 'msg_test_2';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const badSignature = 'v1,' + Buffer.from('not-a-real-signature').toString('base64');

  let acceptCalled = false;
  mockFetch(async () => {
    acceptCalled = true;
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => '' };
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
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => '' };
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

  mockFetch(async () => ({
    ok: false,
    status: 400,
    headers: new Headers(),
    json: async () => ({ error: { message: 'bad request from openai' } }),
    text: async () => 'bad request from openai',
  }));

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

await run('with TRANSFER_TARGET_URI configured, transfer_call tool is offered', async () => {
  process.env.TRANSFER_TARGET_URI = 'tel:+441234567890';
  // The webhook module reads env vars at import time, so re-import fresh
  // with a cache-busting query param to pick up the new env var.
  const { default: handlerWithTransfer } = await import(
    '../api/openai/realtime-webhook.js?transfer-test=' + Date.now()
  );

  const payload = eventPayload({ data: { call_id: 'rtc_transfer_test', sip_headers: [] } });
  const webhookId = 'msg_test_6';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(WEBHOOK_SECRET, webhookId, timestamp, payload);

  let acceptCall = null;
  mockFetch(async (url, opts) => {
    acceptCall = { url: String(url), opts };
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => '' };
  });

  const req = makeReq({
    url: '/api/openai/realtime-webhook',
    headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
    body: payload,
  });
  const res = makeRes();
  try {
    await handlerWithTransfer(req, res);
  } finally {
    restoreFetch();
    delete process.env.TRANSFER_TARGET_URI;
  }

  assert.equal(res.statusCode, 200);
  const sentBody = JSON.parse(acceptCall.opts.body);
  const toolNames = sentBody.tools.map((t) => t.name);
  assert.ok(toolNames.includes('transfer_call'));
  assert.match(sentBody.instructions, /transfer_call tool/);
});

console.log('realtime-webhook tests done');
