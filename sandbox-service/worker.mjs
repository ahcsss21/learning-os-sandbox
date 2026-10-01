import { PGlite } from '@electric-sql/pglite';

const MAX_SQL_LENGTH = 40_000;
const MAX_ROWS = 500;

function readOnlySql(sql) {
  const clean = sql.trim().replace(/;\s*$/, '');
  const withoutComments = clean.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!/^\s*(select|with)\b/i.test(withoutComments)) throw new Error('Only read-only SELECT queries are allowed.');
  if (/;/.test(withoutComments)) throw new Error('Run one SQL statement at a time.');
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do|execute|prepare|commit|rollback|pg_read_file|pg_read_binary_file|lo_import|dblink)\b/i.test(withoutComments)) {
    throw new Error('This query contains a statement or function disabled in the sandbox.');
  }
  return clean;
}

function normalizeValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(normalizeValue);
  return value;
}

async function main(payload) {
  const { schemaSql = '', dataSql = '', schemaName = 'public', action } = payload;
  if (typeof schemaSql !== 'string' || typeof dataSql !== 'string' || schemaSql.length > 100_000 || dataSql.length > 500_000) {
    throw new Error('Schema/data package exceeds sandbox limits.');
  }

  const db = new PGlite();
  try {
    await db.waitReady;
    await db.exec('SET statement_timeout = 5000');
    if (schemaSql.trim()) await db.exec(schemaSql);
    if (dataSql.trim()) await db.exec(dataSql);
    if (/^[a-z_][a-z0-9_]{0,62}$/i.test(schemaName)) await db.exec(`SET search_path TO "${schemaName}", public`);

    if (action === 'validate-schema') {
      const tables = await db.query('select tablename from pg_tables where schemaname = $1 order by tablename', [schemaName]);
      const tableNames = tables.rows.map((row) => row.tablename);
      if (!tableNames.length) throw new Error('No tables found in the declared schema.');
      if (tableNames.length > 20) throw new Error('A schema may contain at most 20 tables.');
      return { success: true, tableNames };
    }

    if (action === 'execute') return { success: true, ...(await execute(db, payload.query)) };

    if (action === 'execute-many') {
      if (!Array.isArray(payload.queries) || payload.queries.length < 1 || payload.queries.length > 20) throw new Error('Provide between 1 and 20 reference queries.');
      const results = [];
      for (let index = 0; index < payload.queries.length; index++) {
        try { results.push(await execute(db, payload.queries[index])); }
        catch (error) { return { success: false, failedIndex: index, error: error.message || 'Reference query failed.', sqlstate: error.code ?? null }; }
      }
      return { success: true, results };
    }

    throw new Error('Unknown sandbox action.');
  } finally {
    await db.close();
  }
}

async function execute(db, sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > MAX_SQL_LENGTH) throw new Error('Enter a query under 40,000 characters.');
  const safeSql = readOnlySql(sql);
  const result = await db.query(`select * from (${safeSql}) as learner_result limit ${MAX_ROWS + 1}`);
  const columns = result.fields.map((field) => field.name);
  const rows = result.rows.map((row) => Object.fromEntries(columns.map((column) => [column, normalizeValue(row[column])])));
  if (rows.length > MAX_ROWS) throw new Error('This query returned more than 500 rows. Add a filter or LIMIT.');
  return { columns, rows };
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const result = await main(JSON.parse(input));
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ success: false, error: error.message || 'Sandbox operation failed.', sqlstate: error.code ?? null }));
}
