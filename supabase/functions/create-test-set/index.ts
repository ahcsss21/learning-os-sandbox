import { getOwnedSchema, handleOptions, requireUser, respond, sandboxRequest, serviceClient } from '../_shared/platform.ts';

function normalizeEmail(value: unknown) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeSkill(value: unknown) {
  return String(value ?? '').trim().slice(0, 80);
}

Deno.serve(async (request) => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;
  try {
    const user = await requireUser(request);
    const testerEmails = new Set((Deno.env.get('TESTER_EMAILS') ?? '').split(',').map(normalizeEmail).filter(Boolean));
    if (!testerEmails.size) return respond({ error: 'Tester authoring is not configured.' }, 503);
    if (!testerEmails.has(normalizeEmail(user.email))) return respond({ error: 'Tester access is required to assign curated sets.' }, 403);

    const body = await request.json();
    const schemaId = String(body.schemaId ?? '');
    const learnerEmail = normalizeEmail(body.learnerEmail);
    const difficulty = String(body.difficulty ?? '');
    const questions = Array.isArray(body.questions) ? body.questions : [];
    if (!schemaId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(learnerEmail)) return respond({ error: 'Choose an owned schema and enter a valid learner email.' }, 400);
    if (!['low', 'medium', 'high'].includes(difficulty)) return respond({ error: 'Choose low, medium, or high difficulty.' }, 400);
    if (!questions.length || questions.length > 20) return respond({ error: 'A curated set must contain between 1 and 20 questions.' }, 400);
    if (JSON.stringify(questions).length > 200_000) return respond({ error: 'The question set is too large.' }, 413);

    const admin = serviceClient();
    const schema = await getOwnedSchema(admin, schemaId, user.id);
    let learner: { id: string; email: string } | null = null;
    for (let page = 1; page <= 100 && !learner; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      const found = data.users.find((candidate) => normalizeEmail(candidate.email) === learnerEmail);
      if (found?.email) learner = { id: found.id, email: found.email };
      if (data.users.length < 1000) break;
    }
    if (!learner) return respond({ error: 'No learner account was found for that email.' }, 404);
    if (learner.id === user.id) return respond({ error: 'Choose a learner account other than your tester account.' }, 400);

    const setup = await sandboxRequest('/validate-schema', {
      schemaSql: schema.schema_sql,
      dataSql: schema.data_sql,
      schemaName: schema.schema_name,
    });
    if (!setup.success) throw new Error(String(setup.error ?? 'The selected schema failed sandbox validation.'));

    const candidates = questions.map((item: any, index: number) => {
      const prompt = String(item?.prompt ?? '').trim();
      const referenceSql = String(item?.referenceSql ?? '').trim();
      const fields = Array.isArray(item?.fields) ? item.fields : [];
      if (prompt.length < 10 || prompt.length > 3000) throw new Error(`Question ${index + 1} needs a prompt between 10 and 3,000 characters.`);
      if (!referenceSql || referenceSql.length > 20_000) throw new Error(`Question ${index + 1} needs a reference query under 20,000 characters.`);
      if (!fields.length || fields.length > 12) throw new Error(`Question ${index + 1} needs between 1 and 12 output fields.`);
      const names = fields.map((field: any) => String(field?.name ?? '').trim());
      if (names.some((name: string) => !/^[a-z_][a-z0-9_]{0,62}$/i.test(name)) || new Set(names.map((name: string) => name.toLowerCase())).size !== names.length) {
        throw new Error(`Question ${index + 1} has invalid or duplicate canonical field names.`);
      }
      return {
        prompt,
        referenceSql,
        concepts: Array.isArray(item.concepts) ? item.concepts.map(normalizeSkill).filter(Boolean).slice(0, 10) : [],
        fields: fields.map((field: any) => ({
          name: String(field.name).trim(),
          description: String(field.description ?? '').slice(0, 300),
          aliases: Array.isArray(field.aliases) ? [...new Set(field.aliases.map((alias: unknown) => String(alias).trim()).filter(Boolean))].slice(0, 8) : [],
          tolerance: Number.isFinite(Number(field.tolerance)) ? Math.min(Math.max(Number(field.tolerance), 0), 1) : 0.0001,
        })),
        requiresOrder: Boolean(item.requiresOrder),
        orderDescription: String(item.orderDescription ?? '').slice(0, 500),
      };
    });

    const execution = await sandboxRequest('/execute-many', {
      schemaSql: schema.schema_sql,
      dataSql: schema.data_sql,
      schemaName: schema.schema_name,
      queries: candidates.map((item: any) => item.referenceSql),
    });
    if (!execution.success || !Array.isArray(execution.results) || execution.results.length !== candidates.length) {
      const failedIndex = Number(execution.failedIndex);
      throw new Error(`Question ${Number.isFinite(failedIndex) ? failedIndex + 1 : 1} reference query failed validation: ${String(execution.error ?? 'The sandbox returned incomplete results.')}`);
    }
    const results = execution.results as Array<{ columns: string[]; rows: Record<string, unknown>[] }>;
    for (let index = 0; index < candidates.length; index++) {
      const expected = results[index];
      const names = candidates[index].fields.map((field: any) => field.name);
      if (!expected || !Array.isArray(expected.columns) || !Array.isArray(expected.rows) || expected.rows.length < 1 || expected.rows.length > 500) {
        throw new Error(`Question ${index + 1} must return between 1 and 500 rows.`);
      }
      if (expected.columns.length !== names.length || names.some((name: string) => !expected.columns.includes(name))) {
        throw new Error(`Question ${index + 1} field names must exactly match the reference query's output aliases.`);
      }
      if (candidates[index].requiresOrder && !candidates[index].orderDescription) {
        throw new Error(`Question ${index + 1} requires an order description when ordered results are enabled.`);
      }
    }

    let copiedSchemaId = '';
    try {
      const { data: copiedSchema, error: schemaError } = await admin.from('learning_schemas').insert({
        owner_id: learner.id,
        name: schema.name,
        dialect: schema.dialect,
        schema_name: schema.schema_name,
        table_names: Array.isArray(setup.tableNames) ? setup.tableNames : schema.table_names,
        schema_sql: schema.schema_sql,
        data_sql: schema.data_sql,
        source: 'tester-assigned',
      }).select('id').single();
      if (schemaError) throw schemaError;
      copiedSchemaId = copiedSchema.id;

      const focusConcepts = [...new Set(candidates.flatMap((item: any) => item.concepts))].slice(0, 12);
      const { data: set, error: setError } = await admin.from('question_sets').insert({
        owner_id: learner.id,
        schema_id: copiedSchemaId,
        difficulty,
        question_count: candidates.length,
        focus_concepts: focusConcepts,
        generation_provider: 'tester-authored',
        generation_model: 'curated',
        prompt_version: 'tester-authored-v1',
      }).select('id, schema_id, difficulty, question_count, created_at').single();
      if (setError) throw setError;

      const questionRows = candidates.map((item: any, index: number) => ({
        set_id: set.id,
        owner_id: learner.id,
        ordinal: index + 1,
        prompt: item.prompt,
        difficulty,
        concepts: item.concepts,
        output_contract: { fields: item.fields, orderDescription: item.orderDescription },
        requires_order: item.requiresOrder,
      }));
      const { data: savedQuestions, error: questionsError } = await admin.from('practice_questions').insert(questionRows).select('id, ordinal');
      if (questionsError) throw questionsError;
      const questionIds = new Map((savedQuestions ?? []).map((question) => [question.ordinal, question.id]));
      const keyRows = candidates.map((item: any, index: number) => ({
        question_id: questionIds.get(index + 1),
        owner_id: learner.id,
        reference_sql: item.referenceSql,
        expected_columns: results[index].columns,
        expected_rows: results[index].rows,
        requires_order: item.requiresOrder,
      }));
      if (keyRows.some((row) => !row.question_id)) throw new Error('The saved question list did not match the validated set.');
      const { error: keysError } = await admin.from('practice_question_keys').insert(keyRows);
      if (keysError) throw keysError;
      return respond({ learnerEmail: learner.email, set });
    } catch (error) {
      if (copiedSchemaId) await admin.from('learning_schemas').delete().eq('id', copiedSchemaId);
      throw error;
    }
  } catch (error) {
    console.error('create-test-set failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Could not create the curated question set.' }, 400);
  }
});
