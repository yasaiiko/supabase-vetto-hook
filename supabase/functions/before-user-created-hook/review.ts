// Optional: records signups that went through without a verdict (Vetto slow,
// down or rate limited) in public.signups_pending_review, so failing open stays
// visible. Someone who controls a throwaway domain can make its DNS answer
// slowly on purpose; repeat entries from one network or one mail provider in
// that table are the sign. Queries: supabase/queries/review-unchecked-signups.sql
//
// Runs after the hook has answered (EdgeRuntime.waitUntil), so the longer
// re-check never counts against Supabase's 5 s hook budget.

import { domainOf, recheckDomain, type Unchecked } from './vetto.ts';

export interface UncheckedSignup {
  email: string;
  /** metadata.ip_address from the hook payload. */
  ip?: string;
  reason: Unchecked;
}

export interface ReviewOptions {
  /** SUPABASE_URL, set automatically in Edge Functions. */
  supabaseUrl: string;
  /** SUPABASE_SERVICE_ROLE_KEY, set automatically in Edge Functions. */
  serviceRoleKey: string;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const IP = /^[0-9a-f:.]{2,45}$/i;

export async function recordUnchecked(signup: UncheckedSignup, opts: ReviewOptions): Promise<void> {
  const f = opts.fetch ?? fetch;
  const domain = domainOf(signup.email);
  if (!domain) return;
  const again = await recheckDomain(domain, { fetch: f });

  const res = await f(`${opts.supabaseUrl}/rest/v1/signups_pending_review`, {
    method: 'POST',
    headers: {
      apikey: opts.serviceRoleKey,
      Authorization: `Bearer ${opts.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      email: signup.email.trim(),
      domain,
      ip: signup.ip && IP.test(signup.ip) ? signup.ip : null,
      reason: signup.reason,
      recheck_status: again.status,
      recheck_mx: again.mx,
      recheck_disposable: again.disposable,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`signups_pending_review insert failed: ${res.status} ${await res.text()}`);
}
