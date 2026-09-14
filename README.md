# calmcall-voice

Dedicated, isolated telephony layer for CalmCall's Darren V3. Contains
**only** what's needed to bridge an inbound Twilio call straight into
OpenAI's Realtime SIP endpoint — nothing from the main `calmcall-website`
project, nothing from Darren V2, no marketing pages.

```
Caller → Twilio → POST /api/twilio/voice-v3 → TwiML <Dial><Sip> → OpenAI Realtime SIP
OpenAI → POST /api/openai/realtime-webhook  → verify signature → accept call (Darren's
         session config: instructions, voice, turn detection, tools)
       → background: wss://api.openai.com/v1/realtime?call_id=...  (api/_lib/call-session.js)
         → handles tool calls (submit_lead / end_call / transfer_call) for the life of the call
         → persists the captured lead to Supabase
```

Accepting the call only *starts* it — OpenAI then runs the actual audio
over the SIP/RTP leg it already has open with Twilio, independent of this
server. To react to anything that happens *during* the call (a tool call
Darren makes, the caller hanging up), `api/_lib/call-session.js` opens a
second, sideband WebSocket to the running call using its `call_id`. That
connection is what makes lead capture, transfers, and clean hangups
actually work, not just the greeting.

## Why this project is separate

The previous approach ran Darren V3 on a Vercel *Preview* deployment
protected by Vercel Deployment Protection, reachable only via a bypass
secret embedded in the Twilio webhook URL. Twilio's real server-to-server
request was blocked by that protection layer, which took the number down
to its V1 fallback greeting mid-call. See the incident diagnosis for the
full writeup.

Vercel's Standard Protection (free, on every plan including Hobby)
**exempts production domains**. So instead of fighting deployment
protection with a fragile bypass secret, this project's production domain
is simply public — the way a real inbound telephony/webhook endpoint has
to be, since Twilio and OpenAI are machine callers that can't authenticate
against a login wall. Security instead comes from verifying each
request's signature inside the handler itself:

- **Twilio → `/api/twilio/voice-v3`**: validates `X-Twilio-Signature`
  against `TWILIO_AUTH_TOKEN` using the official `twilio` SDK's
  `validateRequest`, computed over the exact request URL and the raw
  POST body. Invalid signatures get a plain `403`, no TwiML.
- **OpenAI → `/api/openai/realtime-webhook`**: validates the
  `webhook-signature` header (Standard Webhooks spec, HMAC-SHA256) via
  the official `openai` SDK's `client.webhooks.unwrap(...)`, using
  `OPENAI_WEBHOOK_SECRET`. Invalid signatures get a plain `400`.
- **`/api/leads`** (internal, see below) is not public-facing in intent —
  it's protected by a plain shared-secret bearer token
  (`INTERNAL_LEADS_API_SECRET`), since there's no third-party signing
  scheme to verify against for a route only this project's own code (or a
  future internal integration) calls.

Both webhook handlers disable Vercel's default body parser
(`export const config = { api: { bodyParser: false } }`) and read the
**raw** body themselves, because both signature schemes are computed over
the exact bytes on the wire — running them through a JSON/form parser
first and re-serializing would break verification. This is the most
common reason these checks fail on serverless platforms, so it's called
out explicitly in `api/_lib/rawBody.js`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Unauthenticated reachability check. No secrets, no Twilio/OpenAI calls. |
| `POST` | `/api/twilio/voice-v3` | Twilio "A call comes in" webhook. Returns TwiML dialing OpenAI Realtime SIP. |
| `POST` | `/api/openai/realtime-webhook` | OpenAI webhook for `realtime.call.incoming`. Accepts the call, configures Darren's session, and starts the live-call bridge in the background. |
| `POST` | `/api/leads` | Internal, bearer-secret-protected. Persists a lead the same way the live-call bridge does. Not used by the call flow itself — see "Lead persistence" below. |

## Darren himself

`api/_lib/darren-instructions.js` holds the production system prompt:
natural British English, warm-but-brief, gathers name / callback number /
job / details / location / urgency / preferred callback time, reads key
details back before logging them, never claims a message was passed on,
a booking was made, or a transfer happened unless the corresponding tool
call actually confirmed it, and never claims to be human. Override it
entirely with the `DARREN_INSTRUCTIONS` env var if ever needed; the
built-in prompt is meant to be the real one, not a placeholder.

`api/_lib/darren-tools.js` defines what Darren can actually *do* mid-call:

- `submit_lead` — persists the caller's enquiry (see "Lead persistence").
  Darren is instructed to only tell the caller their message has been
  passed on once this reports success.
- `end_call` — ends the call cleanly via OpenAI's hangup endpoint, once
  Darren has said goodbye.
- `transfer_call` — only offered to the model at all when
  `TRANSFER_TARGET_URI` is configured; performs a real SIP `REFER`
  transfer via OpenAI's refer endpoint. Without it configured, Darren is
  told plainly not to offer transfers rather than promise one that can't
  happen.

Barge-in / natural turn-taking comes from the session's
`audio.input.turn_detection` config: `semantic_vad` with
`interrupt_response: true`, which both waits naturally for a caller who
trails off mid-thought and lets them actually cut Darren off mid-sentence
by speaking, rather than a fixed silence timer. `noise_reduction` is set
to `near_field`, correct for handset/phone audio rather than a room mic.
Input audio transcription (`gpt-4o-mini-transcribe`) is enabled so the
call has a real transcript to attach to the lead.

Voice defaults to `cedar` (`OPENAI_REALTIME_VOICE` to override) — one of
the two voices (`marin`/`cedar`) OpenAI recommends for best quality;
accent is steered by the prompt's explicit "natural British English"
instruction rather than by voice selection, since the built-in voices
aren't documented as UK-specific.

## Lead persistence

Matches CalmCall's existing agreed stack (Supabase/Postgres) rather than
inventing a separate store for this one project. `api/_lib/leads.js`
writes directly to a Supabase table via its REST API using the
service-role key (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`), with one
retry on a transient failure before giving up.

**This defaults to a new table, `darren_call_leads`** (override with
`SUPABASE_LEADS_TABLE`) rather than writing into an existing `leads` table
by guesswork — see "What's still blocked on you" below for why, and what
to do about it. Expected columns:

```sql
create table darren_call_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  call_id text,
  call_timestamp timestamptz,
  business_name text,
  caller_name text,
  callback_number text,
  job_type text,
  problem_details text,
  location text,
  urgency text,
  preferred_callback_time text,
  call_summary text,
  transcript jsonb,
  status text not null default 'new',   -- 'new' | 'incomplete'
  raw_sip_headers jsonb
);
```

The live-call bridge calls `saveLead()` **directly, in-process** when
Darren invokes `submit_lead` — not via a network hop through `/api/leads`
— since an extra hop is one more way to lose a lead mid-call for no
benefit. `/api/leads` (bearer-secret protected) exposes the same logic as
a stable integration point for anything else that needs to hand CalmCall
a lead the same way later (a CalmCall OS write-back, a manual-entry tool).

**Every accepted call leaves a record, even an incomplete one.** If the
caller hangs up before Darren calls `submit_lead` (goes silent, calls the
wrong number, etc.), the bridge saves a `status: 'incomplete'` row with
whatever transcript exists rather than silently losing the call.

## Environment variables

Set these in the Vercel project's **Settings → Environment Variables**
(Production). Claude does not enter secret values into any form — a
person with access to the Twilio, OpenAI, and Supabase dashboards needs to
do this step. See `.env.example` for the full annotated list; summary:

| Variable | Required | Where to get it |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Console → Account → API keys & tokens. |
| `OPENAI_API_KEY` | Yes | OpenAI dashboard → API keys. |
| `OPENAI_WEBHOOK_SECRET` | Yes | Created when you register the webhook endpoint URL (see below). |
| `OPENAI_PROJECT_ID` | Recommended | `proj_zJO9c3hazOg8RnLAimXDhrud` (already the code default). |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Yes, before going live | The same Supabase project CalmCall OS already uses. |
| `SUPABASE_LEADS_TABLE` | Optional | Defaults to `darren_call_leads`. |
| `INTERNAL_LEADS_API_SECRET` | Yes, before going live | Any random 32+ byte value — protects `/api/leads`. |
| `BUSINESS_NAME` | Optional | Defaults to `CalmCall`. |
| `TRANSFER_TARGET_URI` | Optional | Only once a real transfer destination exists. |
| `OPENAI_REALTIME_VOICE` | Optional | Defaults to `cedar`. |
| `OPENAI_SIP_HOST` / `OPENAI_REALTIME_MODEL` | Optional | Sensible defaults already in code. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_PHONE_NUMBER` | Not currently read by any handler | Included for reference. |

## Registering the OpenAI webhook

In the OpenAI dashboard, add a webhook endpoint pointing at
`https://<this project's domain>/api/openai/realtime-webhook`, subscribed
to the `realtime.call.incoming` event. OpenAI will generate a signing
secret at that point — that's the value for `OPENAI_WEBHOOK_SECRET`.

## Known limitation: call duration vs. serverless function duration

The live-call bridge (the WebSocket that makes tool calling work) runs
inside the same Vercel function invocation that handled the webhook,
kept alive in the background past the HTTP response via `waitUntil()`
(`@vercel/functions`). Vercel caps how long a single function invocation
can run — `vercel.json` sets this project's webhook function to the
generally-available maximum (`800` seconds ≈ 13 minutes), which requires
a **Pro or Enterprise** Vercel plan (Hobby caps at 300s). If a call runs
past that limit, Vercel will end the invocation: the bridge disconnects,
so a tool call made after that point would go unanswered (Darren would
wait mid-turn) — the underlying SIP audio itself is between Twilio and
OpenAI directly and may or may not continue depending on OpenAI's
behaviour when a sideband connection drops. In practice this only matters
for unusually long calls; 800s is generous for a receptionist call, but
it's worth knowing about before assuming the system has no ceiling.

## Testing before touching the live number

Automated (run `npm test`, or the two commands below individually):

1. `node test/voice-v3.test.js` — Twilio signature verification, TwiML
   shape, method handling.
2. `node test/realtime-webhook.test.js` — OpenAI webhook signature
   verification, the full accept-call session config (voice, turn
   detection, tools), and error handling.
3. `node test/call-session.test.js` — the tool-calling logic itself
   (`submit_lead` / `end_call` / `transfer_call`, transcript capture, the
   "never claim success without confirmation" behaviour), against fake
   events — no real socket or OpenAI call involved.
4. `node test/leads.test.js` / `node test/leads-endpoint.test.js` —
   Supabase persistence (including retry-then-succeed) and the `/api/leads`
   endpoint's auth.

Manual, before touching the live number:

1. `GET /api/health` — confirms the deployment is up and routing here.
2. `POST /api/twilio/voice-v3` with **no** or a **garbage**
   `X-Twilio-Signature` header — must return `403`.
3. `POST /api/openai/realtime-webhook` with **no** or a **garbage**
   `webhook-signature` header — must return `400`.
4. Once env vars are set, point a *second*, non-production Twilio number
   (or the existing number's "Primary handler fails" webhook, which is
   already safely pointed at the V1 pipeline) at this endpoint's real URL
   to get a real signed request through, and confirm TwiML comes back
   valid before ever touching the live number's primary webhook — then
   place an actual test call through that second number and confirm
   Darren answers, holds a conversation, and a row lands in
   `darren_call_leads`.

Only after all of the above passes should the live number's "A call
comes in" webhook be updated — and that update is a manual, explicit step
outside of this repo, deliberately left undone here.

## What's still blocked on you

This environment has no access to the `calmcall-os` / `calmcall-website`
codebases (no linked GitHub account) and no Supabase credentials, so two
things genuinely can't be resolved without you:

1. **Does CalmCall OS already have a lead/webhook endpoint or table for
   this?** If it does, tell me its shape (URL + auth, or table + columns)
   and I'll point `api/_lib/leads.js` at it directly instead of the new
   `darren_call_leads` table. If it doesn't, the table above is the real,
   durable production store as-is — no further code change needed.
2. **Provision the Supabase connection**: run the `create table` SQL
   above against CalmCall's existing Supabase project, then set
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in this Vercel project's
   environment variables (plus a random value for
   `INTERNAL_LEADS_API_SECRET`). I can't do this myself — it needs your
   Supabase dashboard access.

Once those two env vars are set and this project is deployed, the
"place an actual test call" step above is the real end-to-end proof —
and the live number's webhook is the one explicit switch-over step this
repo deliberately leaves for you to flip.
