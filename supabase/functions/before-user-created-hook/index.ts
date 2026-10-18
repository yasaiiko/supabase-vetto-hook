// Supabase Auth "Before User Created" hook (HTTP, Edge Function).
// Rejects disposable and dead-domain emails before the user row exists, for
// every signup path: email/password, magic link, OTP and OAuth.
// Docs: https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';
import { vettoDecision } from './vetto.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A 4xx with an `error` object blocks the signup and sends `message` to the client.
const reject = (message: string) => json({ error: { http_code: 400, message } }, 400);

Deno.serve(async (req) => {
  const payload = await req.text();
  const secret = (Deno.env.get('BEFORE_USER_CREATED_HOOK_SECRET') ?? '').replace('v1,whsec_', '');

  let user: { email?: string };
  try {
    ({ user } = new Webhook(secret).verify(payload, Object.fromEntries(req.headers)) as { user: { email?: string } });
  } catch {
    return json({ error: { http_code: 401, message: 'Invalid signature' } }, 401);
  }

  const decision = await vettoDecision(user.email ?? '', { secretKey: Deno.env.get('VETTO_SECRET_KEY') });
  return decision.ok ? json({}) : reject(decision.message);
});
