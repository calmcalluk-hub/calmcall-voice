// Exercises the real api/_lib/leads.js saveLead() against a mocked Supabase
// REST endpoint: correct insert payload/headers, retry-then-succeed on a
// transient failure, and a clean ok:false (never a thrown error) when the
// store is unreachable or unconfigured.
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.SUPABASE_LEADS_TABLE = 'darren_call_leads_test';

const { saveLead } = await import('../api/_lib/leads.js');

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

await run('saveLead: posts to the configured Supabase table with the service-role key', async () => {
  let captured = null;
  mockFetch(async (url, opts) => {
    captured = { url: String(url), opts };
    return {
      ok: true,
      status: 201,
      json: async () => [{ id: 'row_1' }],
      text: async () => '',
    };
  });

  const result = await saveLead({
    call_id: 'rtc_abc',
    caller_name: 'Dave',
    callback_number: '07700 900123',
    job_type: 'boiler repair',
  }).finally(restoreFetch);

  assert.equal(result.ok, true);
  assert.equal(result.id, 'row_1');
  assert.equal(captured.url, 'https://fake-project.supabase.co/rest/v1/darren_call_leads_test');
  assert.equal(captured.opts.headers.apikey, 'fake-service-role-key');
  assert.equal(captured.opts.headers.Authorization, 'Bearer fake-service-role-key');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body[0].caller_name, 'Dave');
  assert.equal(body[0].status, 'new');
});

await run('saveLead: retries once on a transient failure, then succeeds', async () => {
  let attempts = 0;
  mockFetch(async () => {
    attempts += 1;
    if (attempts === 1) {
      return { ok: false, status: 503, text: async () => 'temporary', json: async () => ({}) };
    }
    return { ok: true, status: 201, json: async () => [{ id: 'row_2' }], text: async () => '' };
  });

  const result = await saveLead({ caller_name: 'Priya', callback_number: '07700 900456', job_type: 'locksmith' }).finally(
    restoreFetch,
  );

  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.id, 'row_2');
});

await run('saveLead: gives up after two failures and returns ok:false without throwing', async () => {
  mockFetch(async () => ({ ok: false, status: 500, text: async () => 'still broken', json: async () => ({}) }));

  const result = await saveLead({ caller_name: 'Someone', callback_number: '0', job_type: 'x' }).finally(restoreFetch);

  assert.equal(result.ok, false);
  assert.match(result.error, /store_rejected_insert/);
});

await run('saveLead: network error -> ok:false, never throws', async () => {
  mockFetch(async () => {
    throw new Error('ECONNRESET');
  });

  const result = await saveLead({ caller_name: 'X', callback_number: '0', job_type: 'y' }).finally(restoreFetch);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'store_unreachable');
});

await run('saveLead: unconfigured store -> ok:false immediately, no network call', async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  let fetchCalled = false;
  mockFetch(async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  });

  const result = await saveLead({ caller_name: 'X', callback_number: '0', job_type: 'y' });

  restoreFetch();
  process.env.SUPABASE_URL = savedUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'leads_store_not_configured');
});

console.log('leads tests done');
