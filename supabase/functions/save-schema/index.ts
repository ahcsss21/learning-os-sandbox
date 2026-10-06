import { handleOptions, requireUser, respond, sandboxRequest, serviceClient } from '../_shared/platform.ts';

function safeIdentifier(value: unknown, fallback: string) {
  const name = String(value ?? fallback).trim().replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  if (!name || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('Schema namespace must be a valid PostgreSQL identifier.');
  return name;
}

Deno.serve(async (request) => {
  const preflight = handleOptions(request);
  if (preflight) return preflight;
  try {
    const user = await requireUser(request);
    const body = await request.json();
    const name = String(body.name ?? '').trim();
    const schemaSql = String(body.schemaSql ?? '');
    const dataSql = String(body.dataSql ?? '');
    const schemaName = safeIdentifier(body.schemaName, 'public');
    if (name.length < 2 || !schemaSql.trim()) return respond({ error: 'Enter a schema name and table definitions.' }, 400);
    if (schemaSql.length > 100_000 || dataSql.length > 500_000) return respond({ error: 'Schema/data text exceeds the current prototype size limit.' }, 413);

    const validation = await sandboxRequest('/validate-schema', { schemaSql, dataSql, schemaName });
    if (!validation.success) throw new Error(String(validation.error ?? 'Schema validation failed.'));
    const tableNames = validation.tableNames as string[];
    if (!Array.isArray(tableNames) || !tableNames.length) throw new Error('No tables were found in the selected schema. Check your CREATE TABLE statements.');
    for (const table of tableNames) if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(table)) throw new Error('A table has a name that is not supported in the sandbox.');

    const admin = serviceClient();
    const { data: schema, error } = await admin.from('learning_schemas').insert({
      owner_id: user.id,
      name: name.slice(0, 100),
      dialect: 'PostgreSQL',
      schema_name: schemaName,
      table_names: tableNames,
      schema_sql: schemaSql,
      data_sql: dataSql,
      source: 'user-created',
    }).select('id, name, dialect, schema_name, table_names, source, created_at').single();
    if (error) throw error;
    return respond({ schema });
  } catch (error) {
    console.error('save-schema failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Could not validate/save the schema.' }, 400);
  }
});
