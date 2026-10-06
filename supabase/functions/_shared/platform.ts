import { createClient } from 'npm:@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export function handleOptions(request: Request) {
  return request.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null;
}

export function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server Supabase configuration is missing.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function requireUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Sign in to continue.');
  const client = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error('Your session is invalid or expired. Please sign in again.');
  return data.user;
}

export function readOnlySql(sql: string) {
  const clean = sql.trim().replace(/;\s*$/, '');
  const withoutComments = clean.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!/^\s*(select|with)\b/i.test(withoutComments)) throw new Error('Only read-only SELECT queries are allowed in the learner sandbox.');
  if (/;/.test(withoutComments)) throw new Error('Run one SQL statement at a time.');
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do|execute|prepare|commit|rollback|pg_sleep|pg_read_file|pg_read_binary_file|lo_import|dblink)\b/i.test(withoutComments)) {
    throw new Error('This query contains a statement or function that is disabled in the learner sandbox.');
  }
  return clean;
}

export async function sandboxRequest(path: string, payload: Record<string, unknown>) {
  const baseUrl = Deno.env.get('SANDBOX_SERVICE_URL')?.replace(/\/+$/, '');
  const token = Deno.env.get('SANDBOX_SERVICE_TOKEN');
  if (!baseUrl || !token) throw new Error('SQL sandbox is not configured. Set SANDBOX_SERVICE_URL and SANDBOX_SERVICE_TOKEN for the Edge Functions.');
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(110_000),
  });
  const responseText = await response.text();
  let result: Record<string, unknown>;
  try { result = JSON.parse(responseText); }
  catch {
    const detail = responseText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`SQL sandbox returned a non-JSON response (${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  if (!response.ok) throw new Error(String(result.error ?? `SQL sandbox request failed (${response.status}).`));
  return result;
}

export function sanitizeSchemaForModel(schemaSql: string) {
  return schemaSql
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "'[literal]'")
    .slice(0, 50_000);
}

export function parseJsonFromModel(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('The language model returned invalid JSON. Try generating again.');
  }
}

export async function askModel(system: string, user: string, temperature = 0.25, maxCompletionTokens?: number) {
  const apiKey = Deno.env.get('LLM_API_KEY');
  if (!apiKey) throw new Error('Question/hint generation is not configured yet. A tester must set the LLM_API_KEY Supabase Function secret.');
  const baseUrl = (Deno.env.get('LLM_BASE_URL') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = Deno.env.get('LLM_MODEL') || 'gpt-4o-mini';
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryingWithoutJsonMode = attempt === 1;
    const completionTokens = maxCompletionTokens
      ? retryingWithoutJsonMode ? Math.min(maxCompletionTokens * 2, 8000) : maxCompletionTokens
      : undefined;
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: retryingWithoutJsonMode ? Math.min(temperature, 0.1) : temperature,
        ...(completionTokens ? { max_completion_tokens: completionTokens } : {}),
        ...(!retryingWithoutJsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: retryingWithoutJsonMode ? `${system}\n\nOutput one valid JSON object only. Do not use markdown fences, comments, or trailing commas.` : system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (response.ok) {
      const payload = await response.json();
      const choice = payload.choices?.[0];
      const message = choice?.message;
      const rawContent = message?.content;
      const content = typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('')
          : '';
      if (content.trim()) {
        try { return { value: parseJsonFromModel(content), provider: baseUrl, model }; }
        catch (error) {
          if (attempt === 0) {
            console.warn('LLM returned non-JSON content; retrying without provider JSON mode.', { model, finishReason: choice?.finish_reason ?? null });
            continue;
          }
          throw error;
        }
      }
      const completionMetadata = {
        model,
        finishReason: choice?.finish_reason ?? null,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        messageKeys: message && typeof message === 'object' ? Object.keys(message) : [],
        refused: Boolean(message?.refusal),
      };
      if (attempt === 0) {
        console.warn('LLM returned an empty completion; retrying without provider JSON mode.', completionMetadata);
        continue;
      }
      console.error('LLM returned an empty completion after retry.', completionMetadata);
      throw new Error('Question service returned an empty response after retry. Please try again.');
    }

    const detail = await response.text();
    let errorCode = '';
    try { errorCode = JSON.parse(detail).error?.code ?? ''; } catch { /* Keep the provider response for logging below. */ }
    if (attempt === 0 && response.status === 400 && errorCode === 'json_validate_failed') {
      console.warn('LLM JSON mode rejected the completion; retrying without provider JSON mode.', { model });
      continue;
    }
    console.error('LLM provider failure', response.status, detail.slice(0, 500));
    throw new Error(`Question service error (${response.status}). Check the LLM provider secret/configuration.`);
  }
  if (!response?.ok) throw new Error('Question service request failed. Try generating again.');
  throw new Error('Question service request failed. Try generating again.');
}

export async function getOwnedSchema(admin: ReturnType<typeof serviceClient>, schemaId: string, userId: string) {
  const { data, error } = await admin.from('learning_schemas').select('*').eq('id', schemaId).eq('owner_id', userId).single();
  if (error || !data) throw new Error('Schema not found or you do not have access to it.');
  return data;
}
