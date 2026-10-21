// Decides whether Supabase Auth should create a user with this email.
// No Deno or Supabase APIs here, so it runs (and is tested) anywhere.
// Every path fails open: a timeout or a Vetto outage never blocks a signup.
// A signup that went through unchecked says why in `unchecked`, so the hook
// can record it for review (see review.ts).

const API = 'https://usevetto.com';
// HTTP hooks get about 5 s in total (retries included): keep the check short.
const TIMEOUT_MS = 2500;
// The background re-check runs after the hook has answered, so it can wait longer.
const RECHECK_TIMEOUT_MS = 8000;

/** Why a signup was allowed without a verdict. */
export type Unchecked =
  | 'timeout' // Vetto didn't answer within TIMEOUT_MS
  | 'unreachable' // network error or a non-ok response (e.g. rate limited)
  | 'dns_error' // Vetto's DNS lookup for the domain failed
  | 'deferred'; // Vetto ran out of lookup budget for this call

export type Decision = { ok: true; unchecked?: Unchecked } | { ok: false; message: string };

export interface VettoOptions {
  /** Vetto Pro secret key (sk_...). Without it, the free keyless domain lookup is used. */
  secretKey?: string;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const ALLOW: Decision = { ok: true };
export const DISPOSABLE = 'Please use a permanent email address. Temporary inboxes are not accepted.';
export const DEAD = 'This email domain cannot receive mail. Please check it for typos.';
export const DEAD_STATUSES = new Set(['nxdomain', 'no_mx_a', 'null_mx', 'no_mail']);

const failed = (err: unknown): Decision => ({
  ok: true,
  unchecked: (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable',
});

export const domainOf = (email: string) => {
  const address = email.trim();
  return address.includes('@') ? address.split('@').pop()?.toLowerCase() || null : null;
};

export async function vettoDecision(email: string, opts: VettoOptions = {}): Promise<Decision> {
  const f = opts.fetch ?? fetch;
  const address = email.trim();
  const domain = domainOf(address);
  if (!domain) return ALLOW; // phone signups, or Supabase rejects it anyway

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
      if (!v.ok) return { ok: true, unchecked: 'unreachable' };
      if (v.verdict === 'block') return { ok: false, message: v.message || DISPOSABLE };
      return ALLOW;
    }

    // Free: keyless lookup of the domain (rate limit: 300 calls/day per IP).
    const r = await auditDomain(f, domain, TIMEOUT_MS);
    if (!r) return { ok: true, unchecked: 'unreachable' };
    if (r.disposable) return { ok: false, message: DISPOSABLE };
    if (DEAD_STATUSES.has(r.status)) return { ok: false, message: DEAD };
    if (r.status === 'error') return { ok: true, unchecked: 'dns_error' };
    if (r.status === 'deferred') return { ok: true, unchecked: 'deferred' };
    return ALLOW;
  } catch (err) {
    return failed(err);
  }
}

export interface DomainInfo {
  /** ok | nxdomain | no_mx_a | null_mx | no_mail | error | deferred | skipped, or `timeout` / `unreachable` from the re-check itself. */
  status: string;
  mx: string[];
  disposable: boolean;
}

async function auditDomain(f: typeof fetch, domain: string, timeoutMs: number): Promise<DomainInfo | null> {
  const res = await f(`${API}/v1/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domains: [domain] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const v = await res.json();
  return v.ok && v.results?.[domain] ? v.results[domain] : null;
}

/** Looks the domain up again with a longer timeout, for the review table. Never throws. */
export async function recheckDomain(domain: string, opts: Pick<VettoOptions, 'fetch'> = {}): Promise<DomainInfo> {
  try {
    return (await auditDomain(opts.fetch ?? fetch, domain, RECHECK_TIMEOUT_MS)) ?? { status: 'unreachable', mx: [], disposable: false };
  } catch (err) {
    return { status: (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable', mx: [], disposable: false };
  }
}
