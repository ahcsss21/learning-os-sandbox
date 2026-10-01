import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { validateLearnerQuery, validateSetupSql } from './sql-safety.mjs';

const { Client, types } = pg;
const MAX_ROWS = 500;
const MAX_SQL_LENGTH = 40_000;
const MAX_SETUP_BYTES = 500_000;
types.setTypeParser(20, (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
});
types.setTypeParser(1700, (value) => Number(value));
types.setTypeParser(1082, (value) => value);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeValue(value, field) {
  if (value instanceof Date) return field.dataTypeID === 1082 ? value.toISOString().slice(0, 10) : value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, field));
  return value;
}

async function execute(client, sql) {
  const safeSql = validateLearnerQuery(sql);
  const result = await client.query(`SELECT * FROM (${safeSql}) AS learner_result LIMIT ${MAX_ROWS + 1}`);
  const fields = result.fields;
  const columns = fields.map((field) => field.name);
  if (new Set(columns).size !== columns.length) throw new Error('Give each output column a distinct name so the result can be checked.');
  const rows = result.rows.map((row) => Object.fromEntries(fields.map((field) => [field.name, normalizeValue(row[field.name], field)])));
  if (rows.length > MAX_ROWS) throw new Error('This query returned more than 500 rows. Add a filter or LIMIT.');
  return { columns, rows };
}

async function main(payload) {
  const { schemaSql = '', dataSql = '', action } = payload;
  if (typeof schemaSql !== 'string' || typeof dataSql !== 'string' || Buffer.byteLength(schemaSql) + Buffer.byteLength(dataSql) > MAX_SETUP_BYTES) {
    throw new Error('Schema/data package exceeds the 500 KB sandbox limit.');
  }
  const schema = validateSetupSql(schemaSql, dataSql);
  if (action === 'execute' && (typeof payload.query !== 'string' || payload.query.length > MAX_SQL_LENGTH)) throw new Error('Enter a query under 40,000 characters.');
  if (action === 'execute-many' && (!Array.isArray(payload.queries) || payload.queries.length < 1 || payload.queries.length > 20)) throw new Error('Provide between 1 and 20 reference queries.');
  if (!['validate-schema', 'execute', 'execute-many'].includes(action)) throw new Error('Unknown sandbox action.');

  const connectionString = process.env.SANDBOX_DATABASE_URL;
  if (!connectionString) throw new Error('Set SANDBOX_DATABASE_URL to the restricted Supabase sandbox-manager connection string.');
  const readerRole = process.env.SANDBOX_READER_ROLE || 'learning_os_sandbox_reader';
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(readerRole)) throw new Error('SANDBOX_READER_ROLE must be a valid PostgreSQL role name.');

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 5_000,
    query_timeout: 8_000,
    application_name: 'learning-os-sandbox',
  });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");

    const schemaName = `los_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query('SELECT set_config($1, $2, true)', ['search_path', `${quoteIdentifier(schemaName)}, pg_catalog`]);
    if (schemaSql.trim()) await client.query(schemaSql);
    if (dataSql.trim()) await client.query(dataSql);

    if (action === 'validate-schema') return { success: true, tableNames: schema.tables };

    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schemaName)} TO ${quoteIdentifier(readerRole)}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdentifier(schemaName)} TO ${quoteIdentifier(readerRole)}`);
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(readerRole)}`);

    if (action === 'execute') return { success: true, ...(await execute(client, payload.query)) };

    const results = [];
    for (let index = 0; index < payload.queries.length; index++) {
      try { results.push(await execute(client, payload.queries[index])); }
      catch (error) { return { success: false, failedIndex: index, error: error.message || 'Reference query failed.', sqlstate: error.code ?? null }; }
    }
    return { success: true, results };
  } finally {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    await client.end().catch(() => {});
  }
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const result = await main(JSON.parse(input));
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ success: false, error: error.message || 'Sandbox operation failed.', sqlstate: error.code ?? null }));
}
