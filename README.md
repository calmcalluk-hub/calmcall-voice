# calmcall-voice

Dedicated, isolated telephony layer for CalmCall's Darren V3. Contains
**only** what's needed to bridge an inbound Twilio call straight into
OpenAI's Realtime SIP endpoint — nothing from the main `calmcall-website`
project, nothing from Darren V2, no marketing pages.

```
Caller → Twilio → POST /api/twilio/voice-v3 → TwiML <Dial><Sip> → OpenAI Realtime SIP
OpenAI → POST /api/openai/realtime-webhook  → verify signature → accept call → session configured
```

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

Both handlers disable Vercel's default body parser
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
| `POST` | `/api/openai/realtime-webhook` | OpenAI webhook for `realtime.call.incoming`. Accepts the call and configures the session. |

## Environment variables

Set these in the Vercel project's **Settings → Environment Variables**
(Production). Claude does not enter secret values into any form — a
person with access to the Twilio and OpenAI dashboards needs to do this
step.

| Variable | Required | Where to get it |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Console → Account → API keys & tokens. Same value already used by the existing `calmcall-website` project — copy it across rather than viewing it twice if you still have it saved somewhere. |
| `OPENAI_API_KEY` | Yes | OpenAI dashboard → API keys. |
| `OPENAI_WEBHOOK_SECRET` | Yes | Created when you register the webhook endpoint URL in the OpenAI dashboard (Webhooks section) — see "Registering the OpenAI webhook" below. |
| `OPENAI_PROJECT_ID` | Recommended | `proj_zJO9c3hazOg8RnLAimXDhrud` (already the code default, but set explicitly so it's visible in the dashboard). |
| `TWILIO_ACCOUNT_SID` | Not currently used by any handler | Included because it was asked for; add it if/when this project grows to do more than webhook verification. |
| `TWILIO_PHONE_NUMBER` | Not currently used by any handler | Same as above — `+441146974507`. |
| `OPENAI_SIP_HOST` | Optional | Defaults to `sip.api.openai.com`. |
| `OPENAI_REALTIME_MODEL` | Optional | Defaults to `gpt-realtime-2.1-mini`. |
| `DARREN_INSTRUCTIONS` | Optional but should be set before going live | Defaults to a generic placeholder persona — **replace with Darren's real production script/system prompt.** This repo doesn't have that copy on file. |

## Registering the OpenAI webhook

In the OpenAI dashboard, add a webhook endpoint pointing at
`https://<this project's domain>/api/openai/realtime-webhook`, subscribed
to the `realtime.call.incoming` event. OpenAI will generate a signing
secret at that point — that's the value for `OPENAI_WEBHOOK_SECRET`.

## Testing before touching the live number

1. `GET /api/health` — confirms the deployment is up and routing here.
2. `POST /api/twilio/voice-v3` with **no** or a **garbage**
   `X-Twilio-Signature` header — must return `403`.
3. `POST /api/openai/realtime-webhook` with **no** or a **garbage**
   `webhook-signature` header — must return `400`.
4. Once env vars are set, point a *second*, non-production Twilio number
   (or the existing number's "Primary handler fails" webhook, which is
   already safely pointed at the V1 pipeline) at this endpoint's real URL
   to get a real signed request through, and confirm TwiML comes back
   valid before ever touching `+441146974507`'s primary webhook.

Only after all of the above passes should the live number's "A call
comes in" webhook be updated — and that update is a manual, explicit step
outside of this repo.
