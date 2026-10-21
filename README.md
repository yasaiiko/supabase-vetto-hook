# Supabase Auth hook: block disposable and fake signups

A Supabase **Before User Created** hook (Edge Function) that rejects throwaway inboxes and email domains that can't receive mail, before the user row exists. It covers every signup path: email/password, magic link, OTP and OAuth.

- **Free, no keys:** checks the domain with [Vetto](https://usevetto.com)'s keyless lookup ([`/v1/audit`](https://usevetto.com/docs#domain-lookup)).
- **Fails open:** if the check is slow or down, the signup goes through. The hook gets 2.5 s of Supabase's 5 s budget. Optionally, [those signups are recorded for review](#review-signups-that-skipped-the-check-optional) instead of passing silently.
- **Privacy relays allowed:** Apple Hide My Email, Firefox Relay and DuckDuckGo forward to real inboxes, so they get through.
- **Tested:** the test starts the function and sends requests signed the way Supabase Auth signs them (Standard Webhooks). An end-to-end test checks what `supabase-js` gets on a real project.

> **Return 200 to reject.** The hook rejects with HTTP **200** and an `error` object in the body. If the hook answers with an HTTP **400**, Supabase Auth returns a 500 "Invalid payload sent to hook" to the client and your message is lost. We checked this on a hosted project with supabase-js 2.118.0 (October 2026).

| Signup email | Hook response | What `supabase-js` returns |
|---|---|---|
| `jane@mailinator.com` | `200 {"error":{"http_code":400,…}}` | `error.message`: "Please use a permanent email address…" |
| `jane@doesnotexist-xyz-123.com` | `200 {"error":{"http_code":400,…}}` | `error.message`: "This email domain cannot receive mail…" |
| `jane@outlook.com`, `jane@privaterelay.appleid.com` | `200 {}` | user created |
| Phone signup (no email) | `200 {}` | user created |
| Unsigned request | `401` | |

## Deploy (hosted Supabase)

1. Supabase Dashboard → **Authentication → Hooks → Add hook → Before User Created** → **HTTPS**.
   URL: `https://<your-project-ref>.supabase.co/functions/v1/before-user-created-hook`. Generate the secret and create the hook. The function doesn't have to exist yet.
2. Deploy. `supabase/config.toml` reads the secret from the environment, so export it first:

   ```bash
   git clone https://github.com/yasaiiko/supabase-vetto-hook
   cd supabase-vetto-hook
   cp .env.example .env   # paste the v1,whsec_... value
   export BEFORE_USER_CREATED_HOOK_SECRET='v1,whsec_...'   # PowerShell: $env:BEFORE_USER_CREATED_HOOK_SECRET='v1,whsec_...'
   supabase link --project-ref <your-project-ref>
   supabase functions deploy before-user-created-hook --no-verify-jwt --use-api
   supabase secrets set --env-file .env
   ```

   `--use-api` bundles on Supabase's side, so Docker isn't needed.
3. Sign up with `x7@mailinator.com`: you get the error. A normal Gmail or Outlook address goes through.

The hook is available on the Supabase Free and Pro plans ([docs](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)).

## Run locally

`supabase/config.toml` already points the local Auth container at the local function. Export the hook secret (any `v1,whsec_<base64>` value) so `env(BEFORE_USER_CREATED_HOOK_SECRET)` resolves, then:

```bash
supabase start
supabase functions serve --env-file .env
```

## Review signups that skipped the check (optional)

Failing open has a weak spot: someone who controls a throwaway domain can make its DNS answer slowly on purpose, and every signup gets through. The hook can't wait longer, but it can keep a record. With `REVIEW_UNCHECKED_SIGNUPS=true`, every signup allowed without a verdict (timeout, Vetto unreachable or rate limited, DNS error) is written to `public.signups_pending_review`. After answering Supabase, the function checks the domain again with an 8 s timeout and stores what it finds (status, MX hosts, disposable). This runs in the background with `EdgeRuntime.waitUntil`, so it never uses the hook's budget.

1. Create the table ([migration](supabase/migrations/20261021000000_signups_pending_review.sql)): `supabase db push`, or paste it into the SQL editor. RLS is on with no policies and `anon`/`authenticated` have no grants. Only the service role (the hook) writes, and you read it from the dashboard.
2. Add `REVIEW_UNCHECKED_SIGNUPS="true"` to `.env` and run `supabase secrets set --env-file .env`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already set in Edge Functions.
3. Once a week, run [`supabase/queries/review-unchecked-signups.sql`](supabase/queries/review-unchecked-signups.sql). Signs to look for:
   - repeat signups from one /24 (IPv4) or /48 (IPv6);
   - one MX provider behind many unrelated domains;
   - domains that were still slow on the re-check;
   - users the re-check says the hook would have blocked.

## Test

Requires [Deno](https://deno.com). The test calls the live keyless lookup.

```bash
deno task test
```

### What the browser receives

The hook rejects with `200` and an `error` object (see the note at the top). To check that `supabase-js` hands that exact text to your UI on your project and version (and not a generic error), run the end-to-end test against a project with the hook enabled. It calls `auth.signUp()` and `auth.signInWithOtp()` with a mailinator address, prints the error the client got, and fails if `error.message` isn't the hook's message:

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon key> deno task test:e2e
```

## Add the browser check (optional)

The hook stops bad emails on the server. To also fix typos (`gmial.com` → "Did you mean gmail.com?") and show the message before the request is sent, add the Vetto script to your signup page. It's free on one site, 1,000 emails a month, no card:

```html
<script src="https://usevetto.com/v.js" data-site="pk_..." defer></script>
```

[`example/signup.html`](example/signup.html) shows both together with `supabase-js`. The hook's message reaches `error.message` (status 400, `AuthApiError`). [`deno task test:e2e`](#what-the-browser-receives) checks that on your project. Keep a fallback message in your UI anyway.

## Vetto Pro

Set `VETTO_SECRET_KEY` (`sk_...`) and the hook calls [`/v1/check`](https://usevetto.com/docs) instead. That adds Gmail alias farming (`j.a.n.e+3@gmail.com`), VPN and data-center signups, burst limits and your own deny list, and every signup shows up in your Vetto dashboard.

Related: [step-by-step guide](https://usevetto.com/block-disposable-emails-supabase) · [Next.js example](https://github.com/yasaiiko/nextjs-vetto-example) · [Better Auth plugin](https://github.com/yasaiiko/better-auth-vetto)

## License

MIT. Disclosure: maintained by the people who build Vetto.
