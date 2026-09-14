// Exercises the real api/twilio/voice-v3.js handler against:
//  1. A correctly signed Twilio request -> expect 200 + <Dial><Sip> TwiML.
//  2. A tampered/invalid signature -> expect 403.
//  3. A missing signature header -> expect 403.
//  4. A non-POST method -> expect 405.
//
// Uses a synthetic TWILIO_AUTH_TOKEN (not the real one) purely to prove
// the validation logic itself is correct: twilio.getExpectedTwilioSignature
// computes what a genuine Twilio request would carry, and the handler
// must accept exactly that and reject everything else.
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { makeReq, makeRes } from './harness.js';

const FAKE_AUTH_TOKEN = 'test_auth_token_not_the_real_one_1234567890';
process.env.TWILIO_AUTH_TOKEN = FAKE_AUTH_TOKEN;
process.env.OPENAI_PROJECT_ID = 'proj_zJO9c3hazOg8RnLAimXDhrud';
process.env.OPENAI_SIP_HOST = 'sip.api.openai.com';

const handlerModule = await import('../api/twilio/voice-v3.js');
const handler = handlerModule.default;

const PUBLIC_URL = 'https://voice.calmcall.co.uk/api/twilio/voice-v3';
const PARAMS = {
  CallSid: 'CATestCallSid00000000000000000000',
  From: '+447000000000',
  To: '+441146974507',
  CallStatus: 'ringing',
};
const bodyString = new URLSearchParams(PARAMS).toString();

function run(name, fn) {
  return fn()
    .then(() => console.log(`PASS  ${name}`))
    .catch((err) => {
      console.error(`FAIL  ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

await run('valid Twilio signature -> 200 with <Dial><Sip> TwiML', async () => {
  const signature = twilio.getExpectedTwilioSignature(FAKE_AUTH_TOKEN, PUBLIC_URL, PARAMS);
  const req = makeReq({
    url: '/api/twilio/voice-v3',
    headers: { host: 'voice.calmcall.co.uk', 'x-forwarded-proto': 'https', 'x-twilio-signature': signature },
    body: bodyString,
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert.match(res.body, /<Dial><Sip>sip:proj_zJO9c3hazOg8RnLAimXDhrud@sip\.api\.openai\.com;transport=tls<\/Sip><\/Dial>/);

  // Confirm it's actually well-formed XML, not just a matching regex.
  const { XMLParser, XMLValidator } = await import('fast-xml-parser');
  const validation = XMLValidator.validate(res.body);
  assert.equal(validation, true, `TwiML is not well-formed XML: ${JSON.stringify(validation)}`);
  const parsed = new XMLParser().parse(res.body);
  assert.ok(parsed.Response.Dial.Sip, 'parsed TwiML missing Response.Dial.Sip');
});

await run('tampered signature -> 403', async () => {
  const signature = twilio.getExpectedTwilioSignature(FAKE_AUTH_TOKEN, PUBLIC_URL, PARAMS);
  const tampered = signature.slice(0, -1) + (signature.slice(-1) === 'A' ? 'B' : 'A');
  const req = makeReq({
    url: '/api/twilio/voice-v3',
    headers: { host: 'voice.calmcall.co.uk', 'x-forwarded-proto': 'https', 'x-twilio-signature': tampered },
    body: bodyString,
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
});

await run('missing signature header -> 403', async () => {
  const req = makeReq({
    url: '/api/twilio/voice-v3',
    headers: { host: 'voice.calmcall.co.uk', 'x-forwarded-proto': 'https' },
    body: bodyString,
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
});

await run('wrong URL (path tampering) -> 403', async () => {
  // Signature was computed for /api/twilio/voice-v3 but request claims a
  // different path — proves the URL reconstruction is actually load-bearing.
  const signature = twilio.getExpectedTwilioSignature(FAKE_AUTH_TOKEN, PUBLIC_URL, PARAMS);
  const req = makeReq({
    url: '/api/twilio/some-other-route',
    headers: { host: 'voice.calmcall.co.uk', 'x-forwarded-proto': 'https', 'x-twilio-signature': signature },
    body: bodyString,
  });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
});

await run('GET -> 405', async () => {
  const req = makeReq({ method: 'GET', url: '/api/twilio/voice-v3', headers: {}, body: '' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405, `expected 405, got ${res.statusCode}: ${res.body}`);
  assert.match(res.body, /Method not allowed/);
});

console.log('voice-v3 tests done');
