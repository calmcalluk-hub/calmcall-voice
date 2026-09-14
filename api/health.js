// GET /api/health
//
// Plain, unauthenticated reachability check for this deployment. Does not
// touch Twilio or OpenAI and reveals no secrets — safe to hit from
// anywhere to confirm the production domain is live and routing to this
// project (as opposed to calmcall-website).
export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'calmcall-voice',
    time: new Date().toISOString(),
  });
}
