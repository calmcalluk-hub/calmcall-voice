// Reads the raw, unparsed request body as a Buffer.
//
// Both the Twilio signature check and the OpenAI webhook signature check
// (Standard Webhooks spec) MUST be computed over the exact bytes that were
// sent on the wire. If Vercel's default body parser touches the request
// first, it re-serializes the body and the signature will never match —
// this is the single most common cause of "signature always invalid" bugs
// on serverless platforms. Every handler in this project disables the
// default parser (`export const config = { api: { bodyParser: false } }`)
// and calls this helper instead.
export default function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
