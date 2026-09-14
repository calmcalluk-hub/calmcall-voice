// Bridges a live, already-accepted realtime call: this is what actually
// makes function calling (and therefore lead capture) work.
//
// Accepting a SIP call over REST (realtime-webhook.js) only configures and
// starts the session — OpenAI then runs the call entirely on its own
// infrastructure over the SIP/RTP leg it already has open with Twilio. To
// see and react to what happens *during* the call (a tool call, a
// transcript line, the caller hanging up), the docs are explicit that you
// attach a normal Realtime WebSocket to the running call using its call_id:
//
//   wss://api.openai.com/v1/realtime?call_id={call_id}
//
// That connection behaves exactly like a regular Realtime API session, so
// tool calls arrive as ordinary `response.function_call_arguments.done`
// events and are answered with `conversation.item.create` +
// `response.create`, same as any other Realtime integration.
//
// The call-handling *logic* (handleRealtimeEvent) is kept pure and
// transport-free on purpose: it only ever touches the `ctx` it's given, so
// it can be unit tested with fake events and spies, with no real network
// connection, no `ws` package, and no live OpenAI call involved (see
// test/call-session.test.js). runCallSession() below is the thin, largely
// untested wiring that connects a real OpenAIRealtimeWS to it.

import { saveLead } from './leads.js';

export function createCallState({ callId, sipHeaders, businessName } = {}) {
  return {
    callId: callId || null,
    sipHeaders: sipHeaders || [],
    businessName: businessName || null,
    transcript: [],
    leadSubmitted: false,
    leadResult: null,
    ended: false,
  };
}

function safeParseArguments(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function functionCallOutput(callId, output) {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output),
    },
  };
}

async function handleSubmitLead(event, ctx) {
  const args = safeParseArguments(event.arguments);
  if (args === null) {
    ctx.send(functionCallOutput(event.call_id, { ok: false, error: 'invalid_arguments' }));
    ctx.send({ type: 'response.create' });
    return;
  }

  const lead = {
    call_id: ctx.state.callId,
    call_timestamp: new Date().toISOString(),
    business_name: ctx.state.businessName,
    caller_name: args.caller_name,
    callback_number: args.callback_number,
    job_type: args.job_type,
    problem_details: args.problem_details,
    location: args.location,
    urgency: args.urgency,
    preferred_callback_time: args.preferred_callback_time,
    call_summary: args.call_summary,
    transcript: ctx.state.transcript,
    status: 'new',
    raw_sip_headers: ctx.state.sipHeaders,
  };

  const result = await ctx.saveLead(lead);
  ctx.state.leadSubmitted = result.ok;
  ctx.state.leadResult = result;

  ctx.send(
    functionCallOutput(
      event.call_id,
      result.ok ? { ok: true, id: result.id || null } : { ok: false, error: result.error || 'save_failed' },
    ),
  );
  ctx.send({ type: 'response.create' });
}

async function handleEndCall(event, ctx) {
  ctx.send(functionCallOutput(event.call_id, { ok: true }));
  ctx.state.ended = true;
  try {
    await ctx.hangup();
  } catch (err) {
    ctx.log('end_call: hangup failed', err && err.message);
  }
}

async function handleTransferCall(event, ctx) {
  if (!ctx.transferTargetUri) {
    ctx.send(functionCallOutput(event.call_id, { ok: false, error: 'transfer_not_configured' }));
    ctx.send({ type: 'response.create' });
    return;
  }

  try {
    await ctx.transfer(ctx.transferTargetUri);
    ctx.send(functionCallOutput(event.call_id, { ok: true }));
  } catch (err) {
    ctx.log('transfer_call failed', err && err.message);
    ctx.send(functionCallOutput(event.call_id, { ok: false, error: 'transfer_failed' }));
    ctx.send({ type: 'response.create' });
  }
}

// Handles a single realtime server event. `ctx` is fully injected so this
// function has no side effects beyond calling the functions it's given:
//   ctx.send(clientEvent)        - send an event back over the socket
//   ctx.state                    - mutable per-call state (see createCallState)
//   ctx.saveLead(lead)           - persist a lead, returns { ok, id?, error? }
//   ctx.hangup()                 - end the call
//   ctx.transfer(targetUri)      - SIP REFER transfer
//   ctx.transferTargetUri        - configured transfer destination, or falsy
//   ctx.log(...)                 - logging hook
export async function handleRealtimeEvent(event, ctx) {
  if (!event || typeof event.type !== 'string') return;

  switch (event.type) {
    case 'conversation.item.input_audio_transcription.completed':
      ctx.state.transcript.push({ role: 'caller', text: event.transcript || '', at: new Date().toISOString() });
      return;

    case 'response.output_audio_transcript.done':
      ctx.state.transcript.push({ role: 'darren', text: event.transcript || '', at: new Date().toISOString() });
      return;

    case 'response.function_call_arguments.done':
      if (event.name === 'submit_lead') return handleSubmitLead(event, ctx);
      if (event.name === 'end_call') return handleEndCall(event, ctx);
      if (event.name === 'transfer_call') return handleTransferCall(event, ctx);
      ctx.send(functionCallOutput(event.call_id, { ok: false, error: 'unknown_tool' }));
      ctx.send({ type: 'response.create' });
      return;

    case 'error':
      ctx.log('realtime error event', event.error || event);
      return;

    default:
      return;
  }
}

// Best-effort save for a call that ended before Darren ever called
// submit_lead (caller hung up early, went silent, etc). Every call that
// reaches OpenAI should leave *some* record — even an incomplete one beats
// silently losing it.
export async function finalizeIncompleteCall(ctx) {
  if (ctx.state.leadSubmitted || ctx.state.transcript.length === 0) return;
  const result = await ctx.saveLead({
    call_id: ctx.state.callId,
    call_timestamp: new Date().toISOString(),
    business_name: ctx.state.businessName,
    transcript: ctx.state.transcript,
    status: 'incomplete',
    raw_sip_headers: ctx.state.sipHeaders,
  });
  if (!result.ok) {
    ctx.log('finalizeIncompleteCall: failed to save fallback record', result.error);
  }
}

// Wires a real OpenAIRealtimeWS connection to the handlers above for the
// duration of one call. Resolves once the socket closes. Intentionally not
// unit tested directly (see module comment) — the real network/websocket
// behaviour is exercised by an actual call, not by this test suite.
export async function runCallSession({ callId, sipHeaders, client, businessName, transferTargetUri }) {
  const { OpenAIRealtimeWS } = await import('openai/realtime/ws');

  const state = createCallState({ callId, sipHeaders, businessName });
  const bridge = new OpenAIRealtimeWS({ callID: callId }, client);

  const ctx = {
    send: (clientEvent) => bridge.send(clientEvent),
    state,
    saveLead,
    transferTargetUri,
    log: (...args) => console.log('[call-session]', callId, ...args),
    hangup: async () => {
      await client.realtime.calls.hangup(callId).catch(() => {});
      bridge.close();
    },
    transfer: async (targetUri) => {
      await client.realtime.calls.refer(callId, { target_uri: targetUri });
    },
  };

  bridge.on('event', (event) => {
    handleRealtimeEvent(event, ctx).catch((err) => ctx.log('handler error', err && err.message));
  });
  bridge.on('error', (err) => ctx.log('socket error', err && err.message));

  bridge.socket.on('open', () => {
    ctx.send({ type: 'response.create' });
  });

  return new Promise((resolve) => {
    bridge.socket.on('close', async () => {
      await finalizeIncompleteCall(ctx).catch((err) => ctx.log('finalize error', err && err.message));
      resolve();
    });
  });
}

// Kicks off a call session without blocking the caller (the webhook handler
// needs to return its 200 to OpenAI quickly, not sit there for the whole
// call). Uses Vercel's waitUntil() so the function instance is kept alive
// in the background for the call's duration when actually deployed on
// Vercel; falls back to a plain fire-and-forget promise anywhere else
// (local dev, tests) so this never throws or blocks the response.
export function scheduleCallSession(args) {
  const promise = runCallSession(args).catch((err) => {
    console.error('[call-session] session ended with error', args.callId, err && err.message);
  });

  import('@vercel/functions')
    .then(({ waitUntil }) => waitUntil(promise))
    .catch(() => {
      // Not running on Vercel (or waitUntil unavailable) - the promise still
      // runs either way, it's just not guaranteed to outlive the response
      // outside of an actual Vercel Fluid-compute deployment.
    });

  return promise;
}

export default runCallSession;
