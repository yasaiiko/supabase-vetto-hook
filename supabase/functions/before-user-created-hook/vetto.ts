// Decides whether Supabase Auth should create a user with this email.
// No Deno or Supabase APIs here, so it runs (and is tested) anywhere.
// Every path fails open: a timeout or a Vetto outage never blocks a signup.

const API = 'https://usevetto.com';
// HTTP hooks get about 5 s in total (retries included): keep the check short.
const TIMEOUT_MS = 2500;

export type Decision = { ok: true } | { ok: false; message: string };

export interface VettoOptions {
  /** Vetto Pro secret key (sk_...). Without it, the free keyless domain lookup is used. */
  secretKey?: string;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const ALLOW: Decision = { ok: true };
export const DISPOSABLE = 'Please use a permanent email address. Temporary inboxes are not accepted.';
export const DEAD = 'This email domain cannot receive mail. Please check it for typos.';
const DEAD_STATUSES = new Set(['nxdomain', 'no_mx_a', 'null_mx', 'no_mail']);

export async function vettoDecision(email: string, opts: VettoOptions = {}): Promise<Decision> {
  const f = opts.fetch ?? fetch;
  const address = email.trim();
  const domain = address.split('@').pop()?.toLowerCase();
  if (!address.includes('@') || !domain) return ALLOW; // phone signups, or Supabase rejects it anyway

  try {
    if (opts.secretKey) {
      // Pro: full check (disposable, dead domain, Gmail aliases, VPN, your rules),
      // recorded in your Vetto dashboard.
      const res = await f(`${API}/v1/check`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const v = await res.json();
      if (v.ok && v.verdict === 'block') return { ok: false, message: v.message || DISPOSABLE };
      return ALLOW;
    }

    // Free: keyless lookup of the domain (rate limit: 300 calls/day per IP).
    const res = await f(`${API}/v1/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: [domain] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const v = await res.json();
    const r = v.ok && v.results ? v.results[domain] : null;
    if (r?.disposable) return { ok: false, message: DISPOSABLE };
    if (r && DEAD_STATUSES.has(r.status)) return { ok: false, message: DEAD };
    return ALLOW;
  } catch {
    return ALLOW;
  }
}
