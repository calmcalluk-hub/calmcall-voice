// Durable lead persistence.
//
// Matches CalmCall's existing agreed stack (Supabase/Postgres) rather than
// inventing a new store for this one project — a lead captured by Darren
// should be reachable the same way any other CalmCall data is. Talks to
// Supabase's PostgREST API directly over fetch (no extra SDK dependency)
// with the service-role key, which must only ever live server-side as a
// Vercel environment variable — never in client code, never logged.
//
// Table defaults to `darren_call_leads` (not `leads`) so this never writes
// into an existing, differently-shaped table by accident. Point
// SUPABASE_LEADS_TABLE at a shared table once its schema is confirmed to
// match (see README).

const DEFAULT_TABLE = 'darren_call_leads';

function config() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const table = process.env.SUPABASE_LEADS_TABLE || DEFAULT_TABLE;
  return { url, serviceRoleKey, table };
}

export function leadsStoreConfigured() {
  const { url, serviceRoleKey } = config();
  return Boolean(url && serviceRoleKey);
}

function normalizeLead(lead) {
  const now = new Date().toISOString();
  return {
    call_id: lead.call_id || null,
    call_timestamp: lead.call_timestamp || now,
    business_name: lead.business_name || null,
    caller_name: lead.caller_name || null,
    callback_number: lead.callback_number || null,
    job_type: lead.job_type || null,
    problem_details: lead.problem_details || null,
    location: lead.location || null,
    urgency: lead.urgency || null,
    preferred_callback_time: lead.preferred_callback_time || null,
    call_summary: lead.call_summary || null,
    transcript: Array.isArray(lead.transcript) ? lead.transcript : null,
    status: lead.status || 'new',
    raw_sip_headers: lead.raw_sip_headers || null,
  };
}

async function insertOnce({ url, serviceRoleKey, table }, row) {
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(table)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([row]),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return { ok: false, status: response.status, detail };
  }

  const body = await response.json().catch(() => null);
  const saved = Array.isArray(body) ? body[0] : null;
  return { ok: true, id: saved && saved.id };
}

// Persists a lead. Retries once on failure (network blip / transient 5xx)
// before giving up, so a single hiccup during a live call doesn't need to
// surface to the caller as a hard failure. Never throws — callers get back
// a plain { ok, id?, error? } result, since the model needs a real boolean
// to react to honestly (see darren-instructions.js).
export async function saveLead(lead) {
  const cfg = config();
  if (!cfg.url || !cfg.serviceRoleKey) {
    console.error('[leads] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured; lead not saved', {
      call_id: lead && lead.call_id,
    });
    return { ok: false, error: 'leads_store_not_configured' };
  }

  const row = normalizeLead(lead);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await insertOnce(cfg, row);
      if (result.ok) return { ok: true, id: result.id };
      console.error('[leads] insert failed', { attempt, status: result.status, detail: result.detail });
      if (attempt === 2) return { ok: false, error: `store_rejected_insert_${result.status}` };
    } catch (err) {
      console.error('[leads] insert threw', { attempt, message: err && err.message });
      if (attempt === 2) return { ok: false, error: 'store_unreachable' };
    }
  }

  return { ok: false, error: 'unknown' };
}

export default saveLead;
