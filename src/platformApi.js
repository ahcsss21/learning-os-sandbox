import { supabase } from './supabase';

function requireClient() {
  if (!supabase) throw new Error('Supabase is not configured. Add the project URL and anon key to .env.local.');
  return supabase;
}

async function invoke(name, body) {
  const client = requireClient();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) {
    const response = error.context;
    if (response instanceof Response) {
      try {
        const details = await response.clone().json();
        throw new Error(details.error || details.message || error.message);
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message !== error.message) throw parseError;
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function signUp(email, password) {
  const { data, error } = await requireClient().auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await requireClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function requestPasswordReset(email) {
  const { error } = await requireClient().auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await requireClient().auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await requireClient().auth.signOut();
  if (error) throw error;
}

export async function listOwnedData(userId) {
  const client = requireClient();
  const [schemas, sets, sessions] = await Promise.all([
    client.from('learning_schemas').select('id, name, dialect, schema_name, table_names, source, created_at, updated_at').eq('owner_id', userId).order('updated_at', { ascending: false }),
    client.from('question_sets').select('id, schema_id, difficulty, question_count, focus_concepts, generation_provider, generation_model, created_at').eq('owner_id', userId).order('created_at', { ascending: false }),
    client.from('practice_sessions').select('id, set_id, schema_id, mode, started_at, completed_at, summary').eq('owner_id', userId).order('started_at', { ascending: false }),
  ]);
  for (const response of [schemas, sets, sessions]) if (response.error) throw response.error;
  return { schemas: schemas.data ?? [], sets: sets.data ?? [], sessions: sessions.data ?? [] };
}

export async function saveSchema(schema) {
  const { schema: saved } = await invoke('save-schema', schema);
  return saved;
}

export async function generateSchema(description, difficulty) {
  return invoke('generate-schema', { description, difficulty });
}

export async function generateQuestionSet(input) {
  return invoke('generate-questions', input);
}

export async function createFixedQuestionSet(input) {
  return invoke('create-test-set', input);
}

export async function createSession({ ownerId, setId, schemaId, mode = 'practice' }) {
  const { data, error } = await requireClient().from('practice_sessions').insert({ owner_id: ownerId, set_id: setId, schema_id: schemaId, mode }).select('*').single().abortSignal(AbortSignal.timeout(15_000));
  if (error) throw error;
  return data;
}

export async function getQuestionSet(setId, ownerId) {
  const { data, error } = await requireClient().from('practice_questions').select('id, set_id, ordinal, prompt, difficulty, concepts, output_contract, requires_order').eq('set_id', setId).eq('owner_id', ownerId).order('ordinal').abortSignal(AbortSignal.timeout(15_000));
  if (error) throw error;
  return data ?? [];
}

export async function runSandbox({ schemaId, sessionId, questionId, query, executionMode = 'full', purpose = 'attempt', finalize = false, taskElapsedMs = null }) {
  return invoke('run-query', { schemaId, sessionId, questionId, query, executionMode, purpose, finalize, taskElapsedMs });
}

export async function askForHint({ sessionId, questionId, attemptId }) {
  return invoke('generate-hint', { sessionId, questionId, attemptId });
}

export async function getSessionHistory(sessionId, ownerId) {
  const client = requireClient();
  const { data: session, error: sessionError } = await client.from('practice_sessions').select('id, set_id, schema_id, mode, started_at, completed_at, summary').eq('id', sessionId).eq('owner_id', ownerId).single();
  if (sessionError) throw sessionError;
  const [attempts, hints, questions] = await Promise.all([
    client.from('query_attempts').select('id, question_id, attempt_number, execution_mode, submitted_sql, sql_error, sqlstate, actual_columns, actual_rows, correctness, mismatch_kind, elapsed_ms, created_at').eq('owner_id', ownerId).eq('session_id', sessionId).order('created_at'),
    client.from('hint_events').select('id, question_id, attempt_id, diagnosis, hint_text, provider, model, created_at').eq('owner_id', ownerId).eq('session_id', sessionId).order('created_at'),
    client.from('practice_questions').select('id, prompt, difficulty, concepts, output_contract').eq('owner_id', ownerId).eq('set_id', session.set_id).order('ordinal'),
  ]);
  if (attempts.error) throw attempts.error;
  if (hints.error) throw hints.error;
  if (questions.error) throw questions.error;
  return { session, attempts: attempts.data ?? [], hints: hints.data ?? [], questions: questions.data ?? [] };
}

export async function completeSession(sessionId, ownerId, summary) {
  const { error } = await requireClient().from('practice_sessions').update({ completed_at: new Date().toISOString(), summary }).eq('id', sessionId).eq('owner_id', ownerId);
  if (error) throw error;
}
