// POST /api/twilio/voice-elevenlabs
// Optional inbound route for Darren's ElevenLabs conversational agent.
// Do not point a live Twilio number here until ELEVENLABS_AGENT_ID is set
// and the agent has input/output audio set to ulaw 8000 Hz.
import twilio from 'twilio';
import readRawBody from '../_lib/rawBody.js';

export const config = { api: { bodyParser: false } };

const fallback = '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-GB">Sorry, our phone assistant is temporarily unavailable. Please try again shortly.</Say><Hangup/></Response>';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).send(fallback);

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!authToken || !apiKey || !agentId) {
    console.error('[elevenlabs] required server configuration missing');
    return res.status(503).send(fallback);
  }

  let params;
  try {
    const raw = (await readRawBody(req)).toString('utf8');
    params = Object.fromEntries(new URLSearchParams(raw));
    const signature = req.headers['x-twilio-signature'];
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = `${proto}://${host}${req.url}`;
    if (!signature || !twilio.validateRequest(authToken, signature, url, params)) {
      console.error('[elevenlabs] invalid Twilio signature');
      return res.status(403).send('Forbidden');
    }
  } catch (error) {
    console.error('[elevenlabs] failed to parse signed request', error?.message);
    return res.status(400).send(fallback);
  }

  const from = params.From;
  const to = params.To;
  if (!from || !to) return res.status(400).send(fallback);

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/convai/twilio/register-call', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        from_number: from,
        to_number: to,
        direction: 'inbound',
        conversation_initiation_client_data: {
          dynamic_variables: { caller_number: from }
        }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      console.error('[elevenlabs] register-call failed', response.status);
      return res.status(502).send(fallback);
    }
    const body = await response.text();
    // The API returns TwiML as a string (sometimes JSON-encoded).
    let xml = body.trim();
    if (xml.startsWith('"')) {
      try { xml = JSON.parse(xml); } catch { /* reject malformed response below */ }
    }
    if (typeof xml !== 'string' || !/^\s*(?:<\?xml[^>]*>\s*)?<Response(?:\s|>)/i.test(xml) || !/<\/Response>\s*$/i.test(xml)) {
      console.error('[elevenlabs] register-call returned invalid TwiML');
      return res.status(502).send(fallback);
    }
    return res.status(200).send(xml);
  } catch (error) {
    console.error('[elevenlabs] register-call unavailable', error?.name || 'error');
    return res.status(502).send(fallback);
  }
}
