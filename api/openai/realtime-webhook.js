// POST /api/openai/realtime-webhook
//
// OpenAI Realtime webhook for Darren V3. Handles `realtime.call.incoming`
// (fired when Twilio's <Dial><Sip> reaches OpenAI's Realtime SIP
// connector): verifies the webhook signature, accepts the call with
// Darren's full session configuration (voice, turn detection, tools), then
// hands off to the live-call bridge (api/_lib/call-session.js) which is
// what actually makes lead capture, transfers, and hangups work — accepting
// the call only starts it, it doesn't give us a way to react to what
// happens next. See api/_lib/call-session.js for why that needs a separate
// WebSocket connection.
//
// Like the Twilio endpoint, this is intentionally public — OpenAI cannot
// authenticate against Vercel/Deployment Protection either. The webhook
// signature (Standard Webhooks spec: webhook-id / webhook-timestamp /
// webhook-signature headers, verified with OPENAI_WEBHOOK_SECRET) is the
// actual security boundary.

import OpenAI from 'openai';
import readRawBody from '../_lib/rawBody.js';
import buildDarrenInstructions from '../_lib/darren-instructions.js';
import buildDarrenTools from '../_lib/darren-tools.js';
import { scheduleCallSession } from '../_lib/call-session.js';

export const config = { api: { bodyParser: false } };

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini';
// `marin` and `cedar` are the voices OpenAI recommends for best quality;
// `cedar` reads as warm and conversational, which fits a receptionist.
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'cedar';
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'CalmCall';
// Only set once a real live-transfer destination exists (e.g. a UK mobile
// as tel:+44..., or a SIP URI for a desk phone/PBX). Left unset, Darren is
// told plainly not to offer transfers instead of promising one that can't
// actually happen.
const TRANSFER_TARGET_URI = process.env.TRANSFER_TARGET_URI || '';

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

  const transferAvailable = Boolean(TRANSFER_TARGET_URI);

  try {
    await client.realtime.calls.accept(callId, {
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions: process.env.DARREN_INSTRUCTIONS || buildDarrenInstructions({
        businessName: BUSINESS_NAME,
        transferAvailable,
      }),
      tools: buildDarrenTools({ transferAvailable }),
      tool_choice: 'auto',
      audio: {
        input: {
          // Phone audio arriving over a SIP trunk is effectively
          // close-talking (a handset), not a room mic, so near_field is the
          // right noise-reduction profile here.
          noise_reduction: { type: 'near_field' },
          // Semantic VAD (rather than fixed-silence server_vad) is what
          // gives natural barge-in and turn-taking on a phone call: it
          // waits longer when the caller trails off mid-thought instead of
          // cutting them off after a fixed silence window, and
          // interrupt_response is what lets the caller talk over Darren
          // and have him actually stop.
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'auto',
            create_response: true,
            interrupt_response: true,
          },
          transcription: {
            model: 'gpt-4o-mini-transcribe',
            language: 'en',
          },
        },
        output: {
          voice: REALTIME_VOICE,
        },
      },
    });
  } catch (err) {
    console.error('[realtime-webhook] accept call failed', {
      callId,
      status: err && err.status,
      message: err && err.message,
    });
    return res.status(502).json({ error: 'accept_failed' });
  }

  // The call is accepted and already live at this point. Everything from
  // here on (tool calls, transcript, hangup) happens over a separate
  // WebSocket for the life of the call, kicked off in the background so
  // this webhook response isn't held open for the call's duration.
  // CALMCALL_VOICE_TEST_MODE guards this in the test suite, which asserts
  // on the HTTP response only and must not open a real socket to OpenAI.
  if (process.env.CALMCALL_VOICE_TEST_MODE !== '1') {
    scheduleCallSession({
      callId,
      sipHeaders: event.data.sip_headers,
      client,
      businessName: BUSINESS_NAME,
      transferTargetUri: TRANSFER_TARGET_URI,
    });
  }

  return res.status(200).json({ received: true });
}
