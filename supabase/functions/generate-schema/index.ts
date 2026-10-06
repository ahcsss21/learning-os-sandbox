import { handleOptions, askModel, requireUser, respond, sandboxRequest, serviceClient } from '../_shared/platform.ts';

const systemPrompt = `You design compact, coherent PostgreSQL learning datasets. Return only JSON: {"name":"...","schemaName":"...","schemaSql":"...","dataSql":"...","tableNames":["..."],"summary":"..."}. Create no more than 3 tables and 8 rows per table. Use simple unqualified table and column identifiers, primary/foreign keys, and values that support basic filters, joins, and aggregation. Keep schemaSql under 8,000 characters and dataSql under 12,000 characters. schemaSql may contain only ordinary CREATE TABLE statements; dataSql may contain only INSERT ... VALUES with literal values. Do not include CREATE SCHEMA, schema-qualified identifiers, functions, permissions, transactions, or destructive statements. Never include a learner question or answer key.`;

Deno.serve(async (request) => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;
  try {
    const user = await requireUser(request);
    const { description, difficulty = 'low' } = await request.json();
    if (typeof description !== 'string' || description.trim().length < 8) return respond({ error: 'Describe the data domain in at least a few words.' }, 400);
    const limiter = serviceClient();
    const { count: recentSchemas } = await limiter.from('learning_schemas').select('id', { count: 'exact', head: true }).eq('owner_id', user.id).eq('source', 'llm-generated').gte('created_at', new Date(Date.now() - 3_600_000).toISOString());
    if ((recentSchemas ?? 0) >= 10) return respond({ error: 'You have reached the hourly limit for generated schemas. Try again later.' }, 429);

    const { value, provider, model } = await askModel(systemPrompt, JSON.stringify({ description: description.slice(0, 2000), difficulty }), 0.35, 8000);
    const schemaSql = String(value.schemaSql ?? '');
    const dataSql = String(value.dataSql ?? '');
    const schemaName = String(value.schemaName ?? 'public').replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 50) || 'public';
    if (!/^[a-z_][a-z0-9_]{0,49}$/.test(schemaName)) return respond({ error: 'The generated schema namespace was invalid. Try again.' }, 422);
    if (!schemaSql || schemaSql.length > 20_000 || dataSql.length > 30_000) return respond({ error: 'The generated schema was too large for the sandbox. Try a simpler description with fewer tables and sample rows.' }, 422);

    const validation = await sandboxRequest('/validate-schema', { schemaSql, dataSql, schemaName });
    if (!validation.success) throw new Error(String(validation.error ?? 'Generated schema validation failed.'));
    const tableNames = validation.tableNames as string[];
    if (!Array.isArray(tableNames) || !tableNames.length) throw new Error('The generated schema did not create tables in its declared schema.');
    if (tableNames.length > 3) throw new Error('The generated schema exceeded the 3-table starter limit. Try again with a smaller data domain.');
    for (const table of tableNames) if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(table)) throw new Error('Generated schema contained an invalid table name.');

    const admin = serviceClient();
    const { data: schema, error } = await admin.from('learning_schemas').insert({
      owner_id: user.id,
      name: String(value.name ?? description).slice(0, 100),
      dialect: 'PostgreSQL',
      schema_name: schemaName,
      table_names: tableNames,
      schema_sql: schemaSql,
      data_sql: dataSql,
      source: 'llm-generated',
    }).select('id, name, dialect, schema_name, table_names, created_at').single();
    if (error) throw error;
    return respond({ schema, summary: String(value.summary ?? ''), provider, model });
  } catch (error) {
    console.error('generate-schema failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Could not generate a valid schema.' }, 400);
  }
});
