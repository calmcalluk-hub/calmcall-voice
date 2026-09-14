// POST /api/leads
//
// Internal lead-ingestion endpoint. The live-call bridge (api/_lib/call-session.js)
// calls saveLead() directly in-process and does NOT go through this HTTP
// endpoint — an extra network hop is one more way to lose a lead mid-call
// for no benefit. This route exists as a stable integration point for
// anything else that needs to hand CalmCall a lead the same way (a future
// CalmCall OS write-back, a manual entry tool, another intake channel).
//
// Unlike the Twilio/OpenAI webhooks, this endpoint has no reason to be
// public — it's internal plumbing — so it's protected by a plain shared
// secret rather than a request-signing scheme. Set INTERNAL_LEADS_API_SECRET
// in Vercel and send it as `Authorization: Bearer <secret>`.
import crypto from 'node:crypto';
import readRawBody from './_lib/rawBody.js';
import { saveLead } from './_lib/leads.js';

export const config = { api: { bodyParser: false } };

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  const expected = process.env.INTERNAL_LEADS_API_SECRET;
  if (!expected) return false; // fail closed if unconfigured
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(match[1], expected);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const rawBody = await readRawBody(req);
  let lead;
  try {
    lead = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'invalid_json' });
  }

  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  if (!lead.caller_name && !lead.callback_number) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  const result = await saveLead(lead);
  if (!result.ok) {
    return res.status(502).json({ error: 'save_failed', detail: result.error });
  }
  return res.status(201).json({ ok: true, id: result.id || null });
}
