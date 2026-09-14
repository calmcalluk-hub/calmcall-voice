// POST /api/twilio/voice-v3
//
// Twilio "A call comes in" webhook for Darren V3. Verifies the request
// really came from Twilio (X-Twilio-Signature), then returns TwiML that
// bridges the call directly into OpenAI's Realtime SIP endpoint — no
// text-generation -> TTS -> blob-storage -> Twilio-playback hop, so the
// call gets real-time audio both ways.
//
// This endpoint is intentionally public (Twilio cannot authenticate
// against Vercel/Deployment Protection). Twilio's request signature is
// the actual security boundary — see verifyTwilioSignature() below.

import twilio from 'twilio';
import readRawBody from '../_lib/rawBody.js';

export const config = { api: { bodyParser: false } };

const OPENAI_PROJECT_ID =
  process.env.OPENAI_PROJECT_ID || 'proj_zJO9c3hazOg8RnLAimXDhrud';
const OPENAI_SIP_HOST = process.env.OPENAI_SIP_HOST || 'sip.api.openai.com';

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

// Reconstructs the exact public URL Twilio requested, and validates the
// X-Twilio-Signature header against it using the account's Auth Token.
// Twilio's algorithm (implemented by twilio.validateRequest) is:
//   base64( HMAC-SHA1( AuthToken, URL + sorted(key+value for each POST param) ) )
// so the URL here must byte-for-byte match what Twilio actually requested
// (scheme + host + path + query string) — a mismatch (e.g. wrong scheme,
// or a proxy rewriting the path) is the usual reason a genuine Twilio
// request fails validation.
function verifyTwilioSignature(req, rawBodyString) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return { ok: false, reason: 'TWILIO_AUTH_TOKEN is not configured' };
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    return { ok: false, reason: 'missing X-Twilio-Signature header' };
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.url}`;

  const params = Object.fromEntries(new URLSearchParams(rawBodyString));

  const valid = twilio.validateRequest(authToken, signature, url, params);
  return valid ? { ok: true, params, url } : { ok: false, reason: 'signature mismatch', url };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send(twiml('<Say>Method not allowed.</Say><Hangup/>'));
  }

  const rawBody = await readRawBody(req);
  const rawBodyString = rawBody.toString('utf8');

  const check = verifyTwilioSignature(req, rawBodyString);
  if (!check.ok) {
    // Do not leak details to the caller — log server-side only.
    console.error('[voice-v3] rejected request: invalid Twilio signature', {
      reason: check.reason,
      url: check.url,
      from: req.headers['x-forwarded-for'],
    });
    return res.status(403).send('Forbidden');
  }

  if (!OPENAI_PROJECT_ID) {
    console.error('[voice-v3] missing OPENAI_PROJECT_ID');
    return res
      .status(200)
      .send(twiml('<Say>Sorry, we are having trouble connecting you. Please try again shortly.</Say><Hangup/>'));
  }

  const sipUri = `sip:${OPENAI_PROJECT_ID}@${OPENAI_SIP_HOST};transport=tls`;
  return res.status(200).send(twiml(`<Dial><Sip>${xmlEscape(sipUri)}</Sip></Dial>`));
}
