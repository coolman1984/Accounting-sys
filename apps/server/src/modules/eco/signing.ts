import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { wallClockMs } from '../../kernel/dates.js';

/**
 * Request signing for machine calls (plan 50 WP-X2): a signature over `METHOD|path?query|sha256(body)|timestamp`.
 * The HMAC key is the SHA-256 of the machine key: receivers keep only that hash, so both sides can compute it and a stolen
 * copy of the receiver's table cannot be used as a key (it is the signing key, but not the `x-eco-key` that opens the door).
 * A replayed or altered request fails: a signature older than five minutes is refused, and so is one for another path or body.
 * Additive: a request without a signature is still accepted unless ECO_REQUIRE_SIGNATURE=1.
 */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export const sha256hex = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

export function signRequest(keyHash: string, method: string, pathWithQuery: string, body: string, timestamp: number): string {
  return createHmac('sha256', keyHash).update(`${method.toUpperCase()}|${pathWithQuery}|${sha256hex(body)}|${timestamp}`).digest('hex');
}

/** The headers a sender adds for a key text it holds (the real clock: signatures are about now, not about the simulated day). */
export function signatureHeaders(key: string, method: string, pathWithQuery: string, body: string, now = wallClockMs()): Record<string, string> {
  return { 'x-eco-ts': String(now), 'x-eco-sig': signRequest(sha256hex(key), method, pathWithQuery, body, now) };
}

export type SignatureProblem = 'auth.signature_required' | 'auth.signature_malformed' | 'auth.signature_expired' | 'auth.signature_invalid';

/** null when the request is acceptable; otherwise the reason. `required` makes an unsigned request a problem. */
export function checkSignature(input: { keyHash: string; method: string; pathWithQuery: string; rawBody: string; ts: unknown; sig: unknown; now?: number; required: boolean }): SignatureProblem | null {
  const { ts, sig } = input;
  if (ts === undefined && sig === undefined) return input.required ? 'auth.signature_required' : null;
  if (typeof ts !== 'string' || typeof sig !== 'string' || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return 'auth.signature_malformed';
  if (Math.abs((input.now ?? wallClockMs()) - Number(ts)) > SIGNATURE_WINDOW_MS) return 'auth.signature_expired';
  const want = signRequest(input.keyHash, input.method, input.pathWithQuery, input.rawBody, Number(ts));
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? null : 'auth.signature_invalid';
}
