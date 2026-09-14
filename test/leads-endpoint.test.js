// Exercises the real api/leads.js handler: auth required, valid payload
// persists (via a mocked Supabase call), invalid payload/auth rejected.
import assert from 'node:assert/strict';
import { makeReq, makeRes } from './harness.js';

process.env.INTERNAL_LEADS_API_SECRET = 'test-internal-secret';
process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.SUPABASE_LEADS_TABLE = 'darren_call_leads_test';

const handlerModule = await import('../api/leads.js');
const handler = handlerModule.default;

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

await run('valid secret + valid lead -> 201, persisted', async () => {
  mockFetch(async () => ({ ok: true, status: 201, json: async () => [{ id: 'row_9' }], text: async () => '' }));
  const req = makeReq({
    url: '/api/leads',
    headers: { authorization: 'Bearer test-internal-secret' },
    body: JSON.stringify({ caller_name: 'Dave', callback_number: '07700 900123', job_type: 'boiler repair' }),
  });
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    restoreFetch();
  }
  assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.id, 'row_9');
});

await run('missing Authorization header -> 401, no save attempted', async () => {
  let called = false;
  mockFetch(async () => {
    called = true;
    return { ok: true, status: 201, json: async () => [], text: async () => '' };
  });
  const req = makeReq({
    url: '/api/leads',
    headers: {},
    body: JSON.stringify({ caller_name: 'Dave', callback_number: '1', job_type: 'x' }),
  });
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    restoreFetch();
  }
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

await run('wrong secret -> 401', async () => {
  const req = makeReq({
    url: '/api/leads',
    headers: { authorization: 'Bearer not-the-secret' },
    body: JSON.stringify({ caller_name: 'Dave', callback_number: '1', job_type: 'x' }),
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

await run('valid secret but missing required fields -> 400', async () => {
  const req = makeReq({
    url: '/api/leads',
    headers: { authorization: 'Bearer test-internal-secret' },
    body: JSON.stringify({ job_type: 'boiler repair' }),
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

await run('valid secret but malformed JSON body -> 400', async () => {
  const req = makeReq({
    url: '/api/leads',
    headers: { authorization: 'Bearer test-internal-secret' },
    body: '{not valid json',
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
});

await run('valid secret + valid lead but the store rejects it -> 502', async () => {
  mockFetch(async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }));
  const req = makeReq({
    url: '/api/leads',
    headers: { authorization: 'Bearer test-internal-secret' },
    body: JSON.stringify({ caller_name: 'Dave', callback_number: '1', job_type: 'x' }),
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
  const req = makeReq({ method: 'GET', url: '/api/leads', headers: {}, body: '' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

console.log('leads-endpoint tests done');
