// Unit tests for the live-call bridge's actual decision logic
// (api/_lib/call-session.js). Deliberately does NOT open a real WebSocket or
// talk to OpenAI — handleRealtimeEvent() is a pure function of (event, ctx),
// so it's exercised directly with fake events and spies for ctx.send /
// ctx.saveLead / ctx.hangup / ctx.transfer. This is what actually proves the
// tool-calling -> lead-persistence flow works, independent of the real
// websocket transport (see the module comment in call-session.js for why).
import assert from 'node:assert/strict';
import { createCallState, handleRealtimeEvent, finalizeIncompleteCall } from '../api/_lib/call-session.js';

function run(name, fn) {
  return fn()
    .then(() => console.log(`PASS  ${name}`))
    .catch((err) => {
      console.error(`FAIL  ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function makeCtx(overrides = {}) {
  const sent = [];
  const logs = [];
  const state = createCallState({ callId: 'rtc_test', sipHeaders: [], businessName: 'CalmCall' });
  return {
    state,
    sent,
    logs,
    send: (event) => sent.push(event),
    saveLead: async (lead) => ({ ok: true, id: 'lead_123', lead }),
    hangup: async () => {},
    transfer: async () => {},
    transferTargetUri: '',
    log: (...args) => logs.push(args),
    ...overrides,
  };
}

function functionCallEvent({ name, args, callId = 'call_abc' }) {
  return {
    type: 'response.function_call_arguments.done',
    call_id: callId,
    item_id: 'item_1',
    name,
    arguments: JSON.stringify(args),
    output_index: 0,
    response_id: 'resp_1',
    event_id: 'evt_1',
  };
}

function parseFunctionCallOutput(sentEvent) {
  assert.equal(sentEvent.type, 'conversation.item.create');
  assert.equal(sentEvent.item.type, 'function_call_output');
  return JSON.parse(sentEvent.item.output);
}

await run('submit_lead: saves the lead and reports ok:true, only after saveLead resolves', async () => {
  const savedLeads = [];
  const ctx = makeCtx({
    saveLead: async (lead) => {
      savedLeads.push(lead);
      return { ok: true, id: 'lead_999' };
    },
  });

  await handleRealtimeEvent(
    functionCallEvent({
      name: 'submit_lead',
      args: {
        caller_name: 'Dave Smith',
        callback_number: '07700 900123',
        job_type: 'boiler repair',
        problem_details: 'No hot water',
        location: 'Exeter',
        urgency: 'today',
        preferred_callback_time: 'this afternoon',
        call_summary: 'Boiler out, needs same-day callout.',
      },
    }),
    ctx,
  );

  assert.equal(savedLeads.length, 1, 'saveLead should be called exactly once');
  assert.equal(savedLeads[0].caller_name, 'Dave Smith');
  assert.equal(savedLeads[0].callback_number, '07700 900123');
  assert.equal(savedLeads[0].call_id, 'rtc_test');
  assert.equal(savedLeads[0].status, 'new');

  assert.equal(ctx.sent.length, 2, 'expected function_call_output then response.create');
  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, true);
  assert.equal(output.id, 'lead_999');
  assert.equal(ctx.sent[1].type, 'response.create');
  assert.equal(ctx.state.leadSubmitted, true);
});

await run('submit_lead: reports ok:false and never claims success when saving fails', async () => {
  const ctx = makeCtx({
    saveLead: async () => ({ ok: false, error: 'store_unreachable' }),
  });

  await handleRealtimeEvent(
    functionCallEvent({
      name: 'submit_lead',
      args: { caller_name: 'Priya', callback_number: '07700 900456', job_type: 'locksmith' },
    }),
    ctx,
  );

  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'store_unreachable');
  assert.equal(ctx.state.leadSubmitted, false, 'a failed save must not be recorded as submitted');
});

await run('submit_lead: malformed tool arguments -> ok:false, saveLead never called', async () => {
  let called = false;
  const ctx = makeCtx({ saveLead: async () => { called = true; return { ok: true }; } });

  await handleRealtimeEvent(
    { ...functionCallEvent({ name: 'submit_lead', args: {} }), arguments: '{not valid json' },
    ctx,
  );

  assert.equal(called, false);
  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'invalid_arguments');
});

await run('end_call: acknowledges the tool call and hangs up', async () => {
  let hungUp = false;
  const ctx = makeCtx({ hangup: async () => { hungUp = true; } });

  await handleRealtimeEvent(functionCallEvent({ name: 'end_call', args: { reason: 'caller said bye' } }), ctx);

  assert.equal(hungUp, true);
  assert.equal(ctx.state.ended, true);
  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, true);
  // No response.create expected after ending the call.
  assert.equal(ctx.sent.length, 1);
});

await run('transfer_call: not configured -> ok:false, never claims a transfer happened', async () => {
  const ctx = makeCtx({ transferTargetUri: '' });
  await handleRealtimeEvent(functionCallEvent({ name: 'transfer_call', args: {} }), ctx);
  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'transfer_not_configured');
});

await run('transfer_call: configured and succeeds -> ok:true', async () => {
  let referredTo = null;
  const ctx = makeCtx({
    transferTargetUri: 'tel:+441234567890',
    transfer: async (uri) => { referredTo = uri; },
  });
  await handleRealtimeEvent(functionCallEvent({ name: 'transfer_call', args: {} }), ctx);
  assert.equal(referredTo, 'tel:+441234567890');
  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, true);
});

await run('transfer_call: configured but the REFER fails -> ok:false, no crash', async () => {
  const ctx = makeCtx({
    transferTargetUri: 'tel:+441234567890',
    transfer: async () => { throw new Error('SIP 500'); },
  });
  await handleRealtimeEvent(functionCallEvent({ name: 'transfer_call', args: {} }), ctx);
  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'transfer_failed');
});

await run('unknown tool name -> ok:false, does not throw', async () => {
  const ctx = makeCtx();
  await handleRealtimeEvent(functionCallEvent({ name: 'do_something_unsupported', args: {} }), ctx);
  const output = parseFunctionCallOutput(ctx.sent[0]);
  assert.equal(output.ok, false);
  assert.equal(output.error, 'unknown_tool');
});

await run('transcript events accumulate caller and Darren lines in order', async () => {
  const ctx = makeCtx();
  await handleRealtimeEvent(
    { type: 'conversation.item.input_audio_transcription.completed', transcript: "It's Dave here" },
    ctx,
  );
  await handleRealtimeEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hi Dave, how can I help?' }, ctx);
  assert.deepEqual(
    ctx.state.transcript.map((t) => [t.role, t.text]),
    [
      ['caller', "It's Dave here"],
      ['darren', 'Hi Dave, how can I help?'],
    ],
  );
});

await run('finalizeIncompleteCall: saves a fallback record if the call ended before submit_lead', async () => {
  const savedLeads = [];
  const ctx = makeCtx({ saveLead: async (lead) => { savedLeads.push(lead); return { ok: true }; } });
  ctx.state.transcript.push({ role: 'caller', text: 'hello?', at: new Date().toISOString() });

  await finalizeIncompleteCall(ctx);

  assert.equal(savedLeads.length, 1);
  assert.equal(savedLeads[0].status, 'incomplete');
});

await run('finalizeIncompleteCall: does nothing if the lead was already submitted', async () => {
  let called = false;
  const ctx = makeCtx({ saveLead: async () => { called = true; return { ok: true }; } });
  ctx.state.leadSubmitted = true;
  ctx.state.transcript.push({ role: 'caller', text: 'hello?', at: new Date().toISOString() });

  await finalizeIncompleteCall(ctx);

  assert.equal(called, false);
});

await run('finalizeIncompleteCall: does nothing for a call with no transcript at all (e.g. immediate hangup)', async () => {
  let called = false;
  const ctx = makeCtx({ saveLead: async () => { called = true; return { ok: true }; } });

  await finalizeIncompleteCall(ctx);

  assert.equal(called, false);
});

console.log('call-session tests done');
