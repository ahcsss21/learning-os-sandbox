import { getOwnedSchema, handleOptions, askModel, requireUser, respond, sandboxRequest, serviceClient } from '../_shared/platform.ts';

const systemPrompt = `You are a SQL curriculum designer. Generate exactly the requested number of distinct questions using only the supplied PostgreSQL schema metadata; no sample data rows are provided to you. Avoid questions that require guessing unseen literal values. Prefer joins, filters on schema-declared values, grouping, counts, sums, averages, and ranking. Return only JSON with {"questions":[{"prompt":"...","concepts":["..."],"referenceSql":"SELECT ...","requiresOrder":true,"orderDescription":"...","fields":[{"name":"canonical_output_name","description":"meaning","aliases":["allowed learner alias"],"tolerance":0.0001}],"difficulty":"low|medium|high"}]}. The prompt must state all required output fields and exact sort/tie rules. If output is numeric, state required rounding/precision. Reference SQL must use only the supplied tables and be read-only. Questions must match the requested difficulty and be solvable from the schema. Do not repeat or paraphrase questions; vary concepts across the set. The expected output of referenceSql must use the canonical field names in fields. Never reveal reference SQL in prompt text.`;
const repairPrompt = `You repair one SQL practice question that failed server-side validation. Return only JSON with {"question":{"prompt":"...","concepts":["..."],"referenceSql":"SELECT ...","requiresOrder":true,"orderDescription":"...","fields":[{"name":"canonical_output_name","description":"meaning","aliases":["allowed learner alias"],"tolerance":0.0001}],"difficulty":"low|medium|high"}}. Use only the supplied schema metadata; no sample data rows or answer results are available. Make referenceSql read-only, syntactically valid, use only existing unqualified tables, return at least one row, and return exactly the fields named in the output contract. Avoid guessed filter literals; prefer a general list or aggregate when the failure says the previous result was empty. Make the learner prompt accurately describe every output field and any required ordering/rounding. Never reveal referenceSql in the prompt.`;

function candidateIssue(item: any, expected: { columns: string[]; rows: Record<string, unknown>[] } | undefined) {
  if (!expected) return 'The reference query produced no result metadata.';
  if (expected.rows.length === 0) return 'The reference query returned zero rows. Avoid guessed filter values and make a question that returns at least one row.';
  if (expected.rows.length > 500) return 'The reference query returned more than 500 rows. Add a useful restriction or aggregation.';
  if (expected.columns.length !== item.fields.length) return 'The output contract field count does not match the reference query columns.';
  const fieldNames = item.fields.map((field: any) => String(field.name));
  if (fieldNames.some((name: string) => !expected.columns.includes(name))) return 'The reference query column aliases do not match the canonical output field names.';
  if (new Set(fieldNames.map((name: string) => name.toLowerCase())).size !== fieldNames.length) return 'Output field names must be unique.';
  const prompt = String(item.candidate.prompt ?? '');
  if (/\bselect\b[\s\S]*\bfrom\b/i.test(prompt)) return 'The learner prompt must not contain SQL.';
  if (item.candidate.requiresOrder && !/\b(order|sort|rank|ascending|descending|asc|desc|top|first|last|latest|earliest)\b/i.test(prompt)) return 'The question requires ordered output but the prompt does not state the sort rule.';
  const hasLongDecimal = expected.rows.some((row) => Object.values(row).some((value) => (typeof value === 'number' || typeof value === 'string') && /^-?\d+\.\d{3,}$/.test(String(value))));
  if (hasLongDecimal && !/\b(round|decimal|precision)/i.test(prompt)) return 'The expected output has long decimals but the prompt does not state the rounding rule.';
  return null;
}

Deno.serve(async (request) => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;
  try {
    const user = await requireUser(request);
    const { schemaId, difficulty, count, focusConcepts = [] } = await request.json();
    if (!['low', 'medium', 'high'].includes(difficulty)) return respond({ error: 'Choose low, medium, or high difficulty.' }, 400);
    const questionCount = Number(count);
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 20) return respond({ error: 'Question count must be between 1 and 20.' }, 400);
    const admin = serviceClient();
    const { count: recentSets } = await admin.from('question_sets').select('id', { count: 'exact', head: true }).eq('owner_id', user.id).gte('created_at', new Date(Date.now() - 3_600_000).toISOString());
    if ((recentSets ?? 0) >= 20) return respond({ error: 'You have reached the hourly limit for generated question sets. Try again later.' }, 429);
    const schema = await getOwnedSchema(admin, String(schemaId ?? ''), user.id);
    // Never send learner-provided sample data to the LLM provider; schema metadata is sufficient to propose questions.
    let generated: { provider: string; model: string } | null = null;
    let candidates: Array<{ candidate: any; referenceSql: string; fields: any[] }> = [];
    for (let modelAttempt = 0; modelAttempt < 3 && !generated; modelAttempt++) {
      const response = await askModel(systemPrompt, JSON.stringify({ difficulty, count: questionCount, focusConcepts, schemaName: schema.name, schemaSql: schema.schema_sql, tableNames: schema.table_names }), 0.45);
      const list = response.value?.questions;
      if (!Array.isArray(list) || list.length !== questionCount) {
        console.warn('generate-questions count mismatch', { requested: questionCount, returned: Array.isArray(list) ? list.length : null, modelAttempt });
        continue;
      }
      const parsed = list.map((candidate: any) => ({ candidate, referenceSql: String(candidate?.referenceSql ?? ''), fields: Array.isArray(candidate?.fields) ? candidate.fields : [] }));
      if (parsed.some((item) => !item.candidate?.prompt || !item.referenceSql || item.fields.length === 0)) {
        console.warn('generate-questions incomplete question object', { modelAttempt });
        continue;
      }
      candidates = parsed;
      generated = { provider: response.provider, model: response.model };
    }
    if (!generated) return respond({ error: 'The question generator could not produce a complete, valid set. Please retry.' }, 422);
    const { provider, model } = generated;
    const sandboxPayload = {
      schemaSql: schema.schema_sql,
      dataSql: schema.data_sql,
      schemaName: schema.schema_name,
    };
    let execution = await sandboxRequest('/execute-many', { ...sandboxPayload, queries: candidates.map((item: any) => item.referenceSql) });
    let validationIssues: string[] = [];
    for (let repairRound = 0; repairRound < 3; repairRound++) {
      const results = execution.success && Array.isArray(execution.results)
        ? execution.results as Array<{ columns: string[]; rows: Record<string, unknown>[] }>
        : [];
      const failedIndex = Number(execution.failedIndex);
      validationIssues = candidates.map((item: any, index: number) => {
        if (!execution.success) return index === failedIndex ? String(execution.error ?? 'The reference SQL did not execute.') : '';
        return candidateIssue(item, results[index]) ?? '';
      });
      const invalidIndexes = validationIssues.map((issue, index) => issue ? index : -1).filter((index) => index >= 0);
      if (!invalidIndexes.length) break;
      if (repairRound === 2) {
        const index = invalidIndexes[0];
        throw new Error(`Generated question ${index + 1} could not be validated after 3 repair attempts: ${validationIssues[index]}`);
      }

      await Promise.all(invalidIndexes.map(async (index) => {
        const current = candidates[index];
        const repair = await askModel(repairPrompt, JSON.stringify({
          difficulty,
          schemaName: schema.name,
          schemaSql: schema.schema_sql,
          question: current.candidate,
          validationIssue: validationIssues[index],
        }), 0.2, 3500);
        const fixed = repair.value.question ?? repair.value;
        const referenceSql = String(fixed.referenceSql ?? '');
        const fields = Array.isArray(fixed.fields) ? fixed.fields : [];
        if (!fixed.prompt || !referenceSql || fields.length === 0) throw new Error(`The model could not repair generated question ${index + 1}.`);
        candidates[index] = { candidate: fixed, referenceSql, fields };
      }));
      execution = await sandboxRequest('/execute-many', { ...sandboxPayload, queries: candidates.map((item: any) => item.referenceSql) });
    }

    if (!execution.success || !Array.isArray(execution.results)) throw new Error('The sandbox could not validate the generated questions. Try generating the set again.');
    const results = execution.results as Array<{ columns: string[]; rows: Record<string, unknown>[] }>;
    const validated = candidates.map((item: any, index: number) => {
      const expected = results[index];
      const issue = candidateIssue(item, expected);
      if (issue) throw new Error(`Generated question ${index + 1} is invalid: ${issue}`);
      return { ...item, expected };
    });

    const { data: set, error: setError } = await admin.from('question_sets').insert({
      owner_id: user.id,
      schema_id: schema.id,
      difficulty,
      question_count: questionCount,
      focus_concepts: Array.isArray(focusConcepts) ? focusConcepts.slice(0, 12) : [],
      generation_provider: provider,
      generation_model: model,
      prompt_version: 'learning-os-question-v1',
    }).select('id, schema_id, difficulty, question_count, created_at').single();
    if (setError) throw setError;

    const publicQuestions = [];
    for (let index = 0; index < validated.length; index++) {
      const item = validated[index];
      const outputContract = { fields: item.fields.map((field: any) => ({ name: String(field.name), description: String(field.description ?? ''), aliases: Array.isArray(field.aliases) ? field.aliases.map(String) : [], tolerance: Number(field.tolerance ?? 0.0001) })), orderDescription: String(item.candidate.orderDescription ?? '') };
      const { data: question, error: questionError } = await admin.from('practice_questions').insert({
        set_id: set.id,
        owner_id: user.id,
        ordinal: index + 1,
        prompt: String(item.candidate.prompt),
        difficulty,
        concepts: Array.isArray(item.candidate.concepts) ? item.candidate.concepts.map(String).slice(0, 10) : [],
        output_contract: outputContract,
        requires_order: Boolean(item.candidate.requiresOrder),
      }).select('id, set_id, ordinal, prompt, difficulty, concepts, output_contract, requires_order').single();
      if (questionError) throw questionError;
      const { error: keyError } = await admin.from('practice_question_keys').insert({
        question_id: question.id,
        owner_id: user.id,
        reference_sql: item.referenceSql,
        expected_columns: item.expected.columns,
        expected_rows: item.expected.rows,
        requires_order: Boolean(item.candidate.requiresOrder),
      });
      if (keyError) throw keyError;
      publicQuestions.push(question);
    }
    return respond({ set, questions: publicQuestions, provider, model });
  } catch (error) {
    console.error('generate-questions failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Could not generate a valid question set.' }, 400);
  }
});
