// What does the browser actually get when the hook rejects a signup?
// Calls supabase-js against a real project that has this hook enabled (hosted,
// or `supabase start` locally) and checks that error.message is the hook's
// message, not a generic one. Skipped unless both variables are set:
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon or publishable key> deno task test:e2e
// Uses a mailinator address, so a working hook creates no user.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { assertEquals } from 'jsr:@std/assert@1';
import { DISPOSABLE } from '../supabase/functions/before-user-created-hook/vetto.ts';

const url = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_ANON_KEY');

Deno.test({
  name: 'supabase-js surfaces the hook message in error.message',
  ignore: !url || !key,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const supabase = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = () => `vetto-e2e-${crypto.randomUUID().slice(0, 8)}@mailinator.com`;
    const report = (path: string, error: { status?: number; code?: string; name?: string; message?: string } | null) =>
      console.log(path, JSON.stringify({ status: error?.status, code: error?.code, name: error?.name, message: error?.message }));

    await t.step('signUp (email + password)', async () => {
      const { data, error } = await supabase.auth.signUp({ email: email(), password: crypto.randomUUID() });
      report('signUp', error);
      assertEquals(data.user, null);
      assertEquals(error?.message, DISPOSABLE);
    });

    await t.step('signInWithOtp (magic link, creates the user)', async () => {
      const { error } = await supabase.auth.signInWithOtp({ email: email(), options: { shouldCreateUser: true } });
      report('signInWithOtp', error);
      assertEquals(error?.message, DISPOSABLE);
    });
  },
});
