import { getOwnedSchema, handleOptions, requireUser, respond, sandboxRequest, serviceClient } from '../_shared/platform.ts';

function valueEqual(actual: unknown, expected: unknown, tolerance: number) {
  if (typeof actual === 'number' && typeof expected === 'number') return Math.abs(actual - expected) <= tolerance;
  if (typeof actual === 'string' && typeof expected === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expected)) return actual.slice(0, 10) === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function compareResult(actual: { columns: string[]; rows: Record<string, unknown>[] }, key: any, contract: any) {
  const fields = Array.isArray(contract?.fields) ? contract.fields : key.expected_columns.map((name: string) => ({ name, aliases: [name], tolerance: 0.0001 }));
  const mapping: Record<string, string> = {};
  for (const field of fields) {
    const aliases = [field.name, ...(field.aliases ?? [])].map((name) => String(name).toLowerCase());
    const found = actual.columns.find((column) => aliases.includes(column.toLowerCase()));
    if (!found) return { correct: false, issue: 'columns', explanation: `A required output field is missing: ${field.name}.` };
    mapping[field.name] = found;
  }
  if (actual.columns.length !== fields.length) return { correct: false, issue: 'columns', explanation: 'The number of output columns does not match the question.' };

  const normalizedRows = actual.rows.map((row) => Object.fromEntries(fields.map((field: any) => [field.name, row[mapping[field.name]]])));
  const expectedRows = key.expected_rows as Record<string, unknown>[];
  if (normalizedRows.length !== expectedRows.length) return { correct: false, issue: 'row-count', explanation: 'The number of returned rows differs from the expected result.' };
  const rowEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => fields.every((field: any) => valueEqual(a[field.name], b[field.name], Number(field.tolerance ?? 0.0001)));

  if (key.requires_order) {
    const samePositions = normalizedRows.every((row, index) => rowEqual(row, expectedRows[index]));
    if (!samePositions) {
      const unused = [...expectedRows];
      for (const row of normalizedRows) {
        const index = unused.findIndex((expected) => rowEqual(row, expected));
        if (index < 0) return { correct: false, issue: 'values', explanation: 'One or more returned rows or values are incorrect.' };
        unused.splice(index, 1);
      }
      return { correct: false, issue: 'ordering', explanation: 'The rows are correct but not in the requested order.' };
    }
  } else {
    const unused = [...expectedRows];
    for (const row of normalizedRows) {
      const index = unused.findIndex((expected) => rowEqual(row, expected));
      if (index < 0) return { correct: false, issue: 'values', explanation: 'One or more returned rows or values are incorrect.' };
      unused.splice(index, 1);
    }
  }
  return { correct: true, issue: null, explanation: 'Yes, this is correct. The complete result set matches the expected answer.' };
}

Deno.serve(async (request) => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;
  try {
    const user = await requireUser(request);
    const { schemaId, sessionId, questionId, query, executionMode = 'full', purpose = 'attempt', finalize = false, taskElapsedMs = null } = await request.json();
    if (typeof query !== 'string' || !query.trim()) return respond({ error: 'Enter a SQL query before running it.' }, 400);
    if (query.length > 20_000) return respond({ error: 'Queries are limited to 20,000 characters.' }, 413);
    if (!schemaId) return respond({ error: 'Select a schema for this session.' }, 400);

    const admin = serviceClient();
    const schema = await getOwnedSchema(admin, String(schemaId), user.id);
    let session: any = null;
    let question: any = null;
    let key: any = null;
    if (purpose !== 'inspect') {
      if (!sessionId || !questionId) return respond({ error: 'A practice session and question are required to record an attempt.' }, 400);
      const [{ data: foundSession, error: sessionError }, { data: foundQuestion, error: questionError }, { data: foundKey, error: keyError }] = await Promise.all([
        admin.from('practice_sessions').select('id, owner_id, schema_id, mode').eq('id', sessionId).eq('owner_id', user.id).single(),
        admin.from('practice_questions').select('id, owner_id, set_id, concepts, output_contract').eq('id', questionId).eq('owner_id', user.id).single(),
        admin.from('practice_question_keys').select('expected_columns, expected_rows, requires_order').eq('question_id', questionId).eq('owner_id', user.id).single(),
      ]);
      if (sessionError || !foundSession || questionError || !foundQuestion || keyError || !foundKey || foundSession.schema_id !== schemaId) return respond({ error: 'Question, session, or answer key is unavailable for this schema.' }, 403);
      session = foundSession; question = foundQuestion; key = foundKey;
      if (session.mode === 'removal') {
        const { count } = await admin.from('hint_events').select('id', { count: 'exact', head: true }).eq('owner_id', user.id).eq('session_id', sessionId);
        if ((count ?? 0) > 0) return respond({ error: 'Hints are disabled during the no-help removal test.' }, 403);
      }
    }

    const startedAt = Date.now();
    let result: { columns: string[]; rows: Record<string, unknown>[] } = { columns: [], rows: [] };
    let sqlError: string | null = null;
    let sqlstate: string | null = null;
    const execution = await sandboxRequest('/execute', {
      schemaSql: schema.schema_sql,
      dataSql: schema.data_sql,
      schemaName: schema.schema_name,
      query,
    });
    if (execution.success) {
      result = { columns: execution.columns as string[], rows: execution.rows as Record<string, unknown>[] };
    } else {
      sqlError = String(execution.error ?? 'Query execution failed.');
      sqlstate = typeof execution.sqlstate === 'string' ? execution.sqlstate : null;
    }

    if (purpose === 'inspect') {
      if (sqlError) return respond({ error: sqlError, sqlstate }, 400);
      return respond({ ...result, correct: null, issue: null });
    }

    const removalPreview = session.mode === 'removal' && !finalize;
    let checked = removalPreview
      ? sqlError
        ? { correct: null, issue: 'sql-error', explanation: sqlError }
        : { correct: null, issue: null, explanation: 'Query executed. Correctness is hidden during the no-help test; submit your final answer when ready.' }
      : sqlError
        ? { correct: false, issue: 'sql-error', explanation: sqlError }
        : compareResult(result, key, question.output_contract);
    const { count } = await admin.from('query_attempts').select('id', { count: 'exact', head: true }).eq('owner_id', user.id).eq('session_id', sessionId).eq('question_id', questionId);
    const attemptNumber = (count ?? 0) + 1;
    const { data: attempt, error: attemptError } = await admin.from('query_attempts').insert({
      owner_id: user.id,
      session_id: sessionId,
      question_id: questionId,
      attempt_number: attemptNumber,
      execution_mode: executionMode === 'selection' ? 'selection' : 'full',
      submitted_sql: query,
      sql_error: sqlError,
      sqlstate,
      actual_columns: result.columns,
      actual_rows: result.rows,
      correctness: checked.correct,
      mismatch_kind: checked.issue,
      is_final: session.mode === 'removal' && Boolean(finalize),
      elapsed_ms: Date.now() - startedAt,
      task_elapsed_ms: Number.isFinite(Number(taskElapsedMs)) && taskElapsedMs !== null ? Math.min(Math.max(Math.round(Number(taskElapsedMs)), 0), 86_400_000) : null,
    }).select('id, question_id, attempt_number, correctness, mismatch_kind, created_at').single();
    if (attemptError) throw attemptError;
    if (checked.correct === true) {
      try {
        const [{ data: earlierCorrect }, { data: priorHints }] = await Promise.all([
          admin.from('query_attempts').select('id').eq('owner_id', user.id).eq('session_id', sessionId).eq('question_id', questionId).eq('correctness', true).neq('id', attempt.id).limit(1),
          admin.from('hint_events').select('diagnosis').eq('owner_id', user.id).eq('session_id', sessionId).eq('question_id', questionId),
        ]);
        if (!earlierCorrect?.length) {
          const assisted = Boolean(priorHints?.length);
          const supportLevel = Math.max(0, ...(priorHints ?? []).map((hint) => Number(hint.diagnosis?.supportLevel ?? 0)));
          const skills = [...new Set((question.concepts ?? []).map((concept: unknown) => String(concept).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)).filter(Boolean))];
          for (const skillKey of skills) {
            const { error: evidenceError } = await admin.rpc('record_learner_skill_success', {
              p_owner_id: user.id,
              p_skill_key: skillKey,
              p_was_assisted: assisted,
              p_support_level: supportLevel,
            });
            if (evidenceError) console.error('Could not record learner skill evidence', evidenceError.message);
          }
        }
      } catch (evidenceError) {
        console.error('Could not record learner skill evidence', evidenceError);
      }
    }
    return respond({ ...result, ...checked, sqlError, sqlstate, attempt });
  } catch (error) {
    console.error('run-query failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Unable to execute this query.' }, 400);
  }
});
