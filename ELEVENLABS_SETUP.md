# Darren Yorkshire voice: ElevenLabs live calls

This is an opt-in replacement for the **audio conversation layer** only. The existing OpenAI Realtime `/api/twilio/voice-v3` endpoint is unchanged. Do not change the Twilio number's live webhook until a test agent and credentials are ready.

## ElevenLabs setup

1. In ElevenLabs, create an **ElevenAgents conversational agent** named Darren. Select the desired Yorkshire voice (the TTS voice ID by itself is *not* an agent ID).
2. Configure the agent's **input and output audio formats to μ-law 8000 Hz** for Twilio.
3. Copy the relevant behaviour and business details from `api/_lib/darren-instructions.js` into the ElevenLabs agent's system prompt. Tool integrations from the OpenAI Realtime implementation do **not** transfer automatically.
4. In the **calmcall-voice** Vercel project, add production environment variables `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`. Keep values secret and server-side. `TWILIO_AUTH_TOKEN` is already expected by this project.
5. Deploy this branch to a **preview**, configure a *test Twilio number*'s incoming voice webhook to `https://<preview-host>/api/twilio/voice-elevenlabs` using POST, and test the call. Note: Vercel Deployment Protection must not block Twilio callbacks.
6. Verify the agent greets, hears speech, responds, and can be interrupted. Only after testing, merge the branch and point the intended Twilio number to `https://calmcall-voice.vercel.app/api/twilio/voice-elevenlabs`.

## What this route does

- Verifies the Twilio request signature before calling ElevenLabs.
- Calls `POST https://api.elevenlabs.io/v1/convai/twilio/register-call` and relays the resulting TwiML to Twilio.
- Returns a safe spoken fallback when the provider is unavailable.
- Does not expose ElevenLabs credentials in TwiML or browser code.

## Limitations and next work

- ElevenLabs' **register-call** integration does not support its native Twilio call transfers. Use the native ElevenLabs phone-number integration if transfers are required.
- Existing `submit_lead`, `end_call`, and `transfer_call` tools in the OpenAI sideband bridge are **not connected** to this new agent. Before real customers use it, configure ElevenLabs tools/webhooks to send lead data to a verified, authenticated CalmCall endpoint and test persistence.
- The ElevenLabs agent controls conversation prompts and voice selection. `ELEVENLABS_VOICE_ID` alone does not configure this route.
- Keep the original `/api/twilio/voice-v3` webhook as rollback until the full lead-capture path is proven.

Official guide: https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call
