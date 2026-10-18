# Supabase Auth hook: block disposable and fake signups

A Supabase **Before User Created** hook (Edge Function) that rejects throwaway inboxes and email domains that can't receive mail, before the user row exists. It covers every signup path: email/password, magic link, OTP and OAuth.

- **Free, no keys:** checks the domain with [Vetto](https://usevetto.com)'s keyless lookup ([`/v1/audit`](https://usevetto.com/docs#domain-lookup)).
- **Fails open:** if the check is slow or down, the signup goes through. The hook gets 2.5 s of Supabase's 5 s budget.
- **Privacy relays allowed:** Apple Hide My Email, Firefox Relay and DuckDuckGo forward to real inboxes, so they get through.
- **Tested:** the test starts the function and sends requests signed the way Supabase Auth signs them (Standard Webhooks).

| Signup email | Hook response |
|---|---|
| `jane@mailinator.com` | `400` "Please use a permanent email address…" |
| `jane@doesnotexist-xyz-123.com` | `400` "This email domain cannot receive mail…" |
| `jane@outlook.com`, `jane@privaterelay.appleid.com` | `200 {}` (allowed) |
| Phone signup (no email) | `200 {}` (allowed) |
| Unsigned request | `401` |

## Deploy (hosted Supabase)

```bash
git clone https://github.com/yasaiiko/supabase-vetto-hook
cd supabase-vetto-hook
supabase link --project-ref <your-project-ref>
supabase functions deploy before-user-created-hook --no-verify-jwt
```

1. Supabase Dashboard → **Authentication → Hooks → Before User Created** → **HTTP**.
2. URL: `https://<your-project-ref>.supabase.co/functions/v1/before-user-created-hook`
3. Generate the secret, then save it as a function secret:

   ```bash
   cp .env.example .env   # paste the v1,whsec_... value
   supabase secrets set --env-file .env
   ```

4. Sign up with `x7@mailinator.com`: you get the error. A normal Gmail or Outlook address goes through.

The hook is available on the Supabase Free and Pro plans ([docs](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)).

## Run locally

`supabase/config.toml` already points the local Auth container at the local function. Export the hook secret (any `v1,whsec_<base64>` value) so `env(BEFORE_USER_CREATED_HOOK_SECRET)` resolves, then:

```bash
supabase start
supabase functions serve --env-file .env
```

## Test

Requires [Deno](https://deno.com). The test calls the live keyless lookup.

```bash
deno task test
```

## Add the browser check (optional)

The hook stops bad emails on the server. To also fix typos (`gmial.com` → "Did you mean gmail.com?") and show the message before the request is sent, add the Vetto script to your signup page. It's free on one site, 1,000 emails a month, no card:

```html
<script src="https://usevetto.com/v.js" data-site="pk_..." defer></script>
```

[`example/signup.html`](example/signup.html) shows both together with `supabase-js`. Keep a fallback message in your UI: the [hooks docs](https://supabase.com/docs/guides/auth/auth-hooks#error-handling) say a hook error reaches the client, but some versions map it to a generic error.

## Vetto Pro

Set `VETTO_SECRET_KEY` (`sk_...`) and the hook calls [`/v1/check`](https://usevetto.com/docs) instead. That adds Gmail alias farming (`j.a.n.e+3@gmail.com`), VPN and data-center signups, burst limits and your own deny list, and every signup shows up in your Vetto dashboard.

Related: [step-by-step guide](https://usevetto.com/block-disposable-emails-supabase) · [Next.js example](https://github.com/yasaiiko/nextjs-vetto-example) · [Better Auth plugin](https://github.com/yasaiiko/better-auth-vetto)

## License

MIT. Disclosure: maintained by the people who build Vetto.
