import { handleOptions, requireUser, respond } from '../_shared/platform.ts';

Deno.serve(async (request) => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;
  try {
    const user = await requireUser(request);
    const allowedEmails = new Set((Deno.env.get('TESTER_EMAILS') ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
    return respond({ isTester: Boolean(user.email && allowedEmails.has(user.email.trim().toLowerCase())) });
  } catch (error) {
    console.error('tester-access failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Could not verify tester access.' }, 401);
  }
});