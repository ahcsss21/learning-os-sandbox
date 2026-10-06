import { getOwnedSchema, handleOptions, askModel, requireUser, respond, serviceClient } from '../_shared/platform.ts';

const systemPrompt = `You are a precise SQL learning coach. Produce exactly one new hint in JSON: {"diagnosis":"short unresolved issue category","hint":"one concise Socratic hint","progressCheck":"what learner should inspect or change next"}. The input includes a support level from 1 to 5. Level 1: broad attention to the task requirement. Level 2: point to the relevant table, column, relationship, or output requirement. Level 3: name the SQL concept. Level 4: describe the clause order, grouping grain, or relationship structure without writing SQL. Level 5: name a useful SQL construct without composing a query. Use the lowest level requested. Diagnose only the latest unresolved issue. If the issue changed, address the new issue at its calibrated level. Use skill evidence only as a calibration signal, never as a label or judgement about the learner. Never output a complete or replacement query, reference SQL, or expected result. Be concrete, Socratic, non-repetitive, and under 45 words.`;

function redactSqlLiterals(sql: string) {
  return sql.replace(/'(?:''|[^'])*'/g, "'[literal]'");
}

function redactError(message: string | null) {
  return (message ?? '').replace(/'(?:''|[^'])*'/g, "'[value]'").slice(0, 800);
}

function issueForAttempt(attempt: any) {
  const state = String(attempt.sqlstate ?? '');
  if (state === '42703') return { key: 'undefined-column', skill: 'identifiers' };
  if (state === '42P01') return { key: 'undefined-table', skill: 'table-relationships' };
  if (state === '42803') return { key: 'grouping-error', skill: 'aggregation' };
  if (state === '42601') return { key: 'syntax-error', skill: 'query-structure' };
  if (state === '42702') return { key: 'ambiguous-column', skill: 'alias-scope' };
  const mismatch = String(attempt.mismatch_kind ?? 'query-logic');
  const skills: Record<string, string> = { columns: 'output-contract', ordering: 'ordering', 'row-count': 'result-grain', values: 'query-logic' };
  return { key: mismatch, skill: skills[mismatch] ?? mismatch };
}

function normalizeSkill(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function skillForIssue(issueSkill: string, concepts: string[]) {
  if (concepts.includes(issueSkill)) return issueSkill;
  const relatedTerms: Record<string, string[]> = {
    identifiers: ['join', 'filter', 'where'],
    'table-relationships': ['join', 'relationship'],
    aggregation: ['aggregation', 'group', 'count', 'sum', 'average'],
    'query-structure': ['subquery', 'cte', 'window', 'join'],
    'alias-scope': ['subquery', 'cte', 'alias', 'window'],
    'output-contract': ['output', 'projection', 'alias'],
    ordering: ['order', 'sort', 'rank', 'window'],
    'result-grain': ['group', 'aggregation', 'distinct', 'grain'],
    'query-logic': ['filter', 'join', 'condition'],
  };
  const related = concepts.find((concept) => (relatedTerms[issueSkill] ?? []).some((term) => concept.includes(term)));
  return related ?? concepts[0] ?? issueSkill;
}

Deno.serve(async (request) => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;
  try {
    const user = await requireUser(request);
    const { sessionId, questionId, attemptId } = await request.json();
    if (!sessionId || !questionId || !attemptId) return respond({ error: 'Run the SQL attempt before requesting a hint.' }, 400);
    const admin = serviceClient();
    const [{ data: session, error: sessionError }, { data: question, error: questionError }, { data: attempt, error: attemptError }] = await Promise.all([
      admin.from('practice_sessions').select('id, owner_id, schema_id, mode').eq('id', sessionId).eq('owner_id', user.id).single(),
      admin.from('practice_questions').select('id, owner_id, prompt, concepts, output_contract').eq('id', questionId).eq('owner_id', user.id).single(),
      admin.from('query_attempts').select('*').eq('id', attemptId).eq('owner_id', user.id).eq('session_id', sessionId).eq('question_id', questionId).single(),
    ]);
    if (sessionError || !session || questionError || !question || attemptError || !attempt) return respond({ error: 'This attempt is not available in your session.' }, 403);
    if (session.mode === 'removal') return respond({ error: 'Hints are disabled during the no-help removal test.' }, 403);
    const schema = await getOwnedSchema(admin, session.schema_id, user.id);
    const [{ data: attempts }, { data: previousHints }] = await Promise.all([
      admin.from('query_attempts').select('id, attempt_number, submitted_sql, sql_error, sqlstate, actual_columns, actual_rows, correctness, mismatch_kind, created_at').eq('owner_id', user.id).eq('session_id', sessionId).eq('question_id', questionId).order('attempt_number', { ascending: true }),
      admin.from('hint_events').select('id, attempt_id, hint_text, diagnosis, created_at').eq('owner_id', user.id).eq('session_id', sessionId).eq('question_id', questionId).order('created_at', { ascending: true }),
    ]);
    const attemptHistory = attempts ?? [];
    if (attemptHistory.at(-1)?.id !== attempt.id) return respond({ error: 'Run your latest query before asking for a hint.' }, 409);
    if (attempt.correctness !== false) return respond({ error: 'Hints are available after an incorrect attempt.' }, 409);
    if ((previousHints ?? []).some((hint) => hint.attempt_id === attempt.id)) return respond({ error: 'You already received a hint for this attempt. Run another query to continue.' }, 409);
    const previousSql = attemptHistory.length > 1 ? attemptHistory[attemptHistory.length - 2].submitted_sql : null;
    const changedSinceLast = previousSql === null || previousSql.trim() !== attempt.submitted_sql.trim();
    const issue = issueForAttempt(attempt);
    const conceptSkills = (question.concepts ?? []).map(normalizeSkill).filter(Boolean);
    const skillKey = skillForIssue(issue.skill, conceptSkills);
    const evidenceKeys = [...new Set([skillKey, ...conceptSkills])];
    const { data: evidenceRows, error: evidenceError } = await admin.from('learner_skill_evidence').select('skill_key, independent_successes, assisted_successes, highest_hint_level').eq('owner_id', user.id).in('skill_key', evidenceKeys);
    if (evidenceError) throw evidenceError;
    const evidence = (evidenceRows ?? []).reduce((summary, row) => ({
      independent: summary.independent + row.independent_successes,
      assisted: summary.assisted + row.assisted_successes,
      highestLevel: Math.max(summary.highestLevel, row.highest_hint_level),
    }), { independent: 0, assisted: 0, highestLevel: 0 });
    let supportLevel = evidence.assisted > evidence.independent && evidence.highestLevel >= 3 ? Math.min(3, evidence.highestLevel) : 1;
    const latestHint = (previousHints ?? []).at(-1);
    if (latestHint?.diagnosis?.skillKey === skillKey && latestHint?.diagnosis?.issueKey === issue.key) {
      const hintedAttempt = attemptHistory.find((item) => item.id === latestHint.attempt_id);
      if (hintedAttempt && attempt.attempt_number > hintedAttempt.attempt_number) {
        supportLevel = Math.min(5, Math.max(supportLevel, Number(latestHint.diagnosis.supportLevel ?? 1) + 1));
      }
    }
    const context = {
      question: question.prompt,
      concepts: question.concepts,
      relevantSchema: schema.schema_sql,
      issueKey: issue.key,
      skillKey,
      supportLevel,
      skillEvidence: evidence,
      supportLadder: ['broad task attention', 'relevant schema/output location', 'underlying SQL concept', 'query structure or grouping grain', 'name one suitable SQL construct'],
      currentAttempt: {
        sql: redactSqlLiterals(attempt.submitted_sql),
        error: redactError(attempt.sql_error),
        sqlstate: attempt.sqlstate,
        resultColumns: attempt.actual_columns,
        resultRowCount: (attempt.actual_rows ?? []).length,
        correctness: attempt.correctness,
        mismatchKind: attempt.mismatch_kind,
      },
      changedSqlSincePreviousAttempt: changedSinceLast,
      previousAttempts: attemptHistory.slice(-5).map((item) => ({ sql: redactSqlLiterals(item.submitted_sql), error: redactError(item.sql_error), sqlstate: item.sqlstate, correct: item.correctness, mismatch: item.mismatch_kind })),
      hintsAlreadyGiven: (previousHints ?? []).slice(-8).map((item) => ({ text: item.hint_text, level: item.diagnosis?.supportLevel, skill: item.diagnosis?.skillKey })),
    };

    let generated: any;
    let provider = '';
    let model = '';
    for (let attemptNo = 0; attemptNo < 3; attemptNo++) {
      const response = await askModel(systemPrompt, JSON.stringify({ ...context, retryNumber: attemptNo + 1 }), 0.25);
      generated = response.value;
      provider = response.provider;
      model = response.model;
      const hintText = String(generated.hint ?? '').trim();
      const repeated = (previousHints ?? []).some((item) => item.hint_text.trim().toLowerCase() === hintText.toLowerCase());
      const looksLikeQuery = /\b(select|from|where|group by|order by)\b[\s\S]*\b(from|join|where|group by)\b/i.test(hintText);
      if (hintText && hintText.split(/\s+/).length <= 45 && !repeated && !looksLikeQuery) break;
      generated = null;
    }
    if (!generated) return respond({ error: 'The coach could not produce a sufficiently new hint. Ask again after another query attempt.' }, 502);

    const hintText = String(generated.hint).trim();
    const { error: claimError } = await admin.from('hint_attempt_claims').insert({ attempt_id: attempt.id, owner_id: user.id });
    if (claimError) {
      if (claimError.code === '23505') return respond({ error: 'You already received a hint for this attempt. Run another query to continue.' }, 409);
      throw claimError;
    }
    const { data: saved, error: saveError } = await admin.from('hint_events').insert({
      owner_id: user.id,
      session_id: sessionId,
      question_id: questionId,
      attempt_id: attempt.id,
      diagnosis: { category: String(generated.diagnosis ?? issue.key), progressCheck: String(generated.progressCheck ?? ''), changedSqlSincePrevious: changedSinceLast, skillKey, issueKey: issue.key, supportLevel },
      hint_text: hintText,
      provider,
      model,
      prompt_version: 'progressive-hint-v2',
    }).select('id, attempt_id, diagnosis, hint_text, created_at').single();
    if (saveError) {
      await admin.from('hint_attempt_claims').delete().eq('attempt_id', attempt.id);
      throw saveError;
    }
    return respond({ hint: saved, changedSqlSincePrevious: changedSinceLast });
  } catch (error) {
    console.error('generate-hint failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Could not generate a contextual hint.' }, 400);
  }
});
