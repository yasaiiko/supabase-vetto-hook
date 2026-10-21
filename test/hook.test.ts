// End-to-end test of the Edge Function: starts it with Deno, sends hook
// requests signed like Supabase Auth does (Standard Webhooks) and checks the
// responses. Free mode, so it calls the live keyless Vetto lookup.
//   deno test --allow-net --allow-env --allow-run --allow-read test/

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { recordUnchecked } from '../supabase/functions/before-user-created-hook/review.ts';
import { DEAD, DISPOSABLE, vettoDecision } from '../supabase/functions/before-user-created-hook/vetto.ts';

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

const reply = (body: unknown) => (() => Promise.resolve(Response.json(body))) as typeof fetch;
const audit = (domain: string, r: Record<string, unknown>) => reply({ ok: true, results: { [domain]: { mx: [], disposable: false, ...r } } });

Deno.test('fails open, and says why', async (t) => {
  await t.step('Vetto unreachable', async () => {
    const down = () => Promise.reject(new Error('network down'));
    assertEquals(await vettoDecision('jane@mailinator.com', { fetch: down as typeof fetch }), { ok: true, unchecked: 'unreachable' });
  });
  await t.step('Vetto too slow', async () => {
    const slow = () => Promise.reject(new DOMException('signal timed out', 'TimeoutError'));
    assertEquals(await vettoDecision('jane@slow-dns.example', { fetch: slow as typeof fetch }), { ok: true, unchecked: 'timeout' });
  });
  await t.step('rate limited', async () => {
    const limited = reply({ ok: false, error: { code: 'rate_limited' } });
    assertEquals(await vettoDecision('jane@acme.example', { fetch: limited }), { ok: true, unchecked: 'unreachable' });
  });
  await t.step('DNS lookup failed', async () => {
    assertEquals(await vettoDecision('jane@acme.example', { fetch: audit('acme.example', { status: 'error' }) }), { ok: true, unchecked: 'dns_error' });
  });
  await t.step('a checked, good domain has no `unchecked`', async () => {
    assertEquals(await vettoDecision('jane@acme.example', { fetch: audit('acme.example', { status: 'ok' }) }), { ok: true });
  });
});

Deno.test('recordUnchecked re-checks the domain and writes the review row', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/audit')) {
      return Promise.resolve(Response.json({ ok: true, results: { 'slow.example': { status: 'ok', mx: ['mx1.throwaway.net'], disposable: true } } }));
    }
    return Promise.resolve(new Response(null, { status: 201 }));
  }) as typeof fetch;

  await recordUnchecked(
    { email: ' Jane@Slow.Example ', ip: '203.0.113.7', reason: 'timeout' },
    { supabaseUrl: 'https://abc.supabase.co', serviceRoleKey: 'service-key', fetch: f },
  );

  assertEquals(calls.map((c) => c.url), ['https://usevetto.com/v1/audit', 'https://abc.supabase.co/rest/v1/signups_pending_review']);
  const insert = calls[1].init;
  assertEquals((insert.headers as Record<string, string>).Authorization, 'Bearer service-key');
  assertEquals(JSON.parse(insert.body as string), {
    email: 'Jane@Slow.Example',
    domain: 'slow.example',
    ip: '203.0.113.7',
    reason: 'timeout',
    recheck_status: 'ok',
    recheck_mx: ['mx1.throwaway.net'],
    recheck_disposable: true,
  });
});

Deno.test('recordUnchecked records a re-check that is still slow, and drops a malformed IP', async () => {
  let row: Record<string, unknown> = {};
  const f = ((url: string, init: RequestInit) => {
    if (url.endsWith('/v1/audit')) return Promise.reject(new DOMException('signal timed out', 'TimeoutError'));
    row = JSON.parse(init.body as string);
    return Promise.resolve(new Response(null, { status: 201 }));
  }) as typeof fetch;

  await recordUnchecked({ email: 'jane@slow.example', ip: 'not-an-ip', reason: 'timeout' }, { supabaseUrl: 'https://abc.supabase.co', serviceRoleKey: 'k', fetch: f });
  assertEquals([row.ip, row.recheck_status, row.recheck_mx], [null, 'timeout', []]);
});

Deno.test('recordUnchecked throws when the insert fails', async () => {
  const f = ((url: string) =>
    Promise.resolve(url.endsWith('/v1/audit') ? Response.json({ ok: false }) : new Response('relation does not exist', { status: 404 }))) as typeof fetch;
  await assertRejects(
    () => recordUnchecked({ email: 'jane@slow.example', reason: 'timeout' }, { supabaseUrl: 'https://abc.supabase.co', serviceRoleKey: 'k', fetch: f }),
    Error,
    'insert failed: 404',
  );
});
