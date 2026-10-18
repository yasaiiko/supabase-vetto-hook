// End-to-end test of the Edge Function: starts it with Deno, sends hook
// requests signed like Supabase Auth does (Standard Webhooks) and checks the
// responses. Free mode, so it calls the live keyless Vetto lookup.
//   deno test --allow-net --allow-env --allow-run --allow-read test/

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';
import { assertEquals } from 'jsr:@std/assert@1';
import { DEAD, DISPOSABLE } from '../supabase/functions/before-user-created-hook/vetto.ts';

const PORT = 8000; // Deno.serve's default port
const SECRET = 'v1,whsec_' + btoa('test-secret-for-the-hook-0123456789');
const URL = `http://localhost:${PORT}/`;

function signed(email: string) {
  const body = JSON.stringify({
    metadata: { uuid: crypto.randomUUID(), time: new Date().toISOString(), name: 'before-user-created', ip_address: '127.0.0.1' },
    user: { id: crypto.randomUUID(), aud: 'authenticated', role: '', email, phone: '', app_metadata: { provider: 'email', providers: ['email'] } },
  });
  const id = `msg_${crypto.randomUUID()}`;
  const now = new Date();
  const signature = new Webhook(SECRET.replace('v1,whsec_', '')).sign(id, now, body);
  return {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
      'webhook-signature': signature,
    },
  };
}

async function call(email: string) {
  const res = await fetch(URL, signed(email));
  return { status: res.status, body: await res.json() };
}

Deno.test('before-user-created hook', async (t) => {
  const server = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-net', '--allow-env', 'supabase/functions/before-user-created-hook/index.ts'],
    env: { BEFORE_USER_CREATED_HOOK_SECRET: SECRET, VETTO_SECRET_KEY: '' },
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(URL, { method: 'POST', body: '' }).then((r) => r.body?.cancel());
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    await t.step('rejects a throwaway inbox', async () => {
      assertEquals(await call('jane@mailinator.com'), { status: 400, body: { error: { http_code: 400, message: DISPOSABLE } } });
    });
    await t.step('rejects a domain that cannot receive mail', async () => {
      assertEquals(await call('jane@doesnotexist-xyz-123.com'), { status: 400, body: { error: { http_code: 400, message: DEAD } } });
    });
    await t.step('allows a real provider', async () => {
      assertEquals(await call('jane@outlook.com'), { status: 200, body: {} });
    });
    await t.step('allows an Apple Hide My Email relay', async () => {
      assertEquals(await call('jane@privaterelay.appleid.com'), { status: 200, body: {} });
    });
    await t.step('allows phone signups (no email)', async () => {
      assertEquals(await call(''), { status: 200, body: {} });
    });
    await t.step('refuses unsigned requests', async () => {
      const res = await fetch(URL, { method: 'POST', body: '{"user":{"email":"a@mailinator.com"}}' });
      assertEquals(res.status, 401);
      await res.body?.cancel();
    });
  } finally {
    server.kill();
    await server.status;
  }
});

Deno.test('fails open when Vetto is unreachable', async () => {
  const { vettoDecision } = await import('../supabase/functions/before-user-created-hook/vetto.ts');
  const down = () => Promise.reject(new Error('network down'));
  assertEquals(await vettoDecision('jane@mailinator.com', { fetch: down as typeof fetch }), { ok: true });
});
