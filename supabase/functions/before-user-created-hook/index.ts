// Supabase Auth "Before User Created" hook (HTTP, Edge Function).
// Rejects disposable and dead-domain emails before the user row exists, for
// every signup path: email/password, magic link, OTP and OAuth.
// Docs: https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';
import { recordUnchecked } from './review.ts';
import { vettoDecision } from './vetto.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A 4xx with an `error` object blocks the signup and sends `message` to the client.
const reject = (message: string) => json({ error: { http_code: 400, message } }, 400);

type Payload = { user: { email?: string }; metadata?: { ip_address?: string } };
type Runtime = { waitUntil(promise: Promise<unknown>): void };

Deno.serve(async (req) => {
  const payload = await req.text();
  const secret = (Deno.env.get('BEFORE_USER_CREATED_HOOK_SECRET') ?? '').replace('v1,whsec_', '');

  let user: Payload['user'], metadata: Payload['metadata'];
  try {
    ({ user, metadata } = new Webhook(secret).verify(payload, Object.fromEntries(req.headers)) as Payload);
  } catch {
    return json({ error: { http_code: 401, message: 'Invalid signature' } }, 401);
  }

  const email = user.email ?? '';
  const decision = await vettoDecision(email, { secretKey: Deno.env.get('VETTO_SECRET_KEY') });
  if (!decision.ok) return reject(decision.message);

  // Optional: keep a record of signups that went through unchecked (see review.ts).
  if (decision.unchecked && Deno.env.get('REVIEW_UNCHECKED_SIGNUPS') === 'true') {
    const task = recordUnchecked(
      { email, ip: metadata?.ip_address, reason: decision.unchecked },
      { supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '', serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' },
    ).catch((err) => console.error(err));
    const runtime = (globalThis as { EdgeRuntime?: Runtime }).EdgeRuntime;
    if (runtime) runtime.waitUntil(task); // answer now, finish in the background
    else await task;
  }
  return json({});
});
