// POST /api/openai/realtime-webhook
//
// OpenAI Realtime webhook for Darren V3. Handles `realtime.call.incoming`
// (fired when Twilio's <Dial><Sip> reaches OpenAI's Realtime SIP
// connector): verifies the webhook signature, then accepts the call and
// configures the realtime session directly — audio flows over the SIP/RTP
// leg OpenAI already has open with Twilio, so there is no separate
// text-generation -> ElevenLabs -> blob storage -> Twilio playback hop.
//
// Like the Twilio endpoint, this is intentionally public — OpenAI cannot
// authenticate against Vercel/Deployment Protection either. The webhook
// signature (Standard Webhooks spec: webhook-id / webhook-timestamp /
// webhook-signature headers, verified with OPENAI_WEBHOOK_SECRET) is the
// actual security boundary.

import OpenAI from 'openai';
import readRawBody from '../_lib/rawBody.js';

export const config = { api: { bodyParser: false } };

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini';

// Placeholder persona — replace with Darren's real production system
// prompt/script before going live. Kept deliberately generic here since
// this project doesn't have Darren's actual copy on file.
const DARREN_INSTRUCTIONS = process.env.DARREN_INSTRUCTIONS || `
You are Darren, a warm, professional phone receptionist for CalmCall, a UK
missed-call recovery service for trades and service businesses. Speak in
natural British English — relaxed, concise, and polite, the way a helpful
local receptionist would. Keep responses short and conversational, confirm
the caller's name and reason for calling, and let them know their message
will be passed on. Never claim to be human if asked directly.
`.trim();

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const webhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!webhookSecret || !apiKey) {
    console.error('[realtime-webhook] missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const rawBody = await readRawBody(req);
  const client = new OpenAI({ apiKey });

  let event;
  try {
    // unwrap() verifies `webhook-signature` (HMAC-SHA256 over
    // "{webhook-id}.{webhook-timestamp}.{raw body}", Standard Webhooks
    // spec) against OPENAI_WEBHOOK_SECRET, and only then parses the JSON.
    event = await client.webhooks.unwrap(rawBody.toString('utf8'), req.headers, webhookSecret);
  } catch (err) {
    console.error('[realtime-webhook] rejected request: invalid signature', {
      name: err && err.name,
      message: err && err.message,
      from: req.headers['x-forwarded-for'],
    });
    return res.status(400).json({ error: 'invalid_signature' });
  }

  if (!isPlainObject(event) || event.type !== 'realtime.call.incoming') {
    // Acknowledge anything we don't handle so OpenAI doesn't retry it.
    console.log('[realtime-webhook] ignoring event type', event && event.type);
    return res.status(200).json({ received: true });
  }

  const callId = event.data && event.data.call_id;
  if (!callId) {
    console.error('[realtime-webhook] realtime.call.incoming with no call_id', event);
    return res.status(400).json({ error: 'missing_call_id' });
  }

  try {
    const acceptResponse = await fetch(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'realtime',
          model: REALTIME_MODEL,
          instructions: DARREN_INSTRUCTIONS,
        }),
      },
    );

    if (!acceptResponse.ok) {
      const detail = await acceptResponse.text().catch(() => '');
      console.error('[realtime-webhook] accept call failed', {
        callId,
        status: acceptResponse.status,
        detail,
      });
      return res.status(502).json({ error: 'accept_failed' });
    }
  } catch (err) {
    console.error('[realtime-webhook] accept call threw', { callId, message: err && err.message });
    return res.status(502).json({ error: 'accept_failed' });
  }

  return res.status(200).json({ received: true });
}
