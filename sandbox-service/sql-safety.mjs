import { parse } from 'pgsql-ast-parser';

const MAX_SETUP_STATEMENTS = 120;
const MAX_TABLES = 20;
const MAX_COLUMNS = 100;
const MAX_SEED_ROWS = 2000;
const checkOperators = new Set(['=', '<>', '!=', '>', '>=', '<', '<=', '+', '-', '*', '/', '%', 'and', 'or']);
const literalTypes = new Set(['integer', 'numeric', 'string', 'boolean', 'null']);
const allowedConstraints = new Set(['primary key', 'not null', 'unique', 'reference', 'default', 'check']);
const allowedFunctions = new Set([
  'abs', 'avg', 'array_agg', 'array_length', 'bool_and', 'bool_or', 'btrim', 'cardinality',
  'ceil', 'ceiling', 'char_length', 'coalesce', 'concat', 'concat_ws', 'count', 'cume_dist',
  'date_part', 'date_trunc', 'dense_rank', 'extract', 'first_value', 'floor', 'greatest',
  'lag', 'last_value', 'least', 'lead', 'left', 'length', 'lower', 'max', 'min', 'mod',
  'nth_value', 'ntile', 'nullif', 'percent_rank', 'position', 'power', 'rank', 'regexp_replace',
  'replace', 'right', 'round', 'row_number', 'split_part', 'sqrt', 'string_agg', 'substring',
  'sum', 'to_char', 'to_date', 'to_timestamp', 'trim', 'upper',
]);

function parseStatements(sql, label) {
  if (typeof sql !== 'string' || !sql.trim()) return [];
  try { return parse(sql); }
  catch (error) { throw new Error(`${label} SQL could not be parsed safely: ${error.message}`); }
}

function visit(value, callback, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  callback(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => visit(item, callback, seen));
    else visit(child, callback, seen);
  }
}

function assertUnqualifiedObjects(statement) {
  visit(statement, (node) => {
    if (node.type === 'table' && node.name?.schema) throw new Error('Schema-qualified table names are not allowed in the sandbox. Use the table name only.');
    if (node.type === 'call' && node.function?.schema) throw new Error('Schema-qualified function calls are not allowed in the sandbox.');
  });
}

function assertAllowedFunctions(statement) {
  visit(statement, (node) => {
    if (node.type === 'call') {
      const name = String(node.function?.name ?? '').toLowerCase();
      if (!allowedFunctions.has(name)) throw new Error(`The ${name || 'unknown'} function is not allowed in the sandbox.`);
    }
  });
}

function isLiteral(value) {
  if (!value || typeof value !== 'object') return false;
  if (literalTypes.has(value.type)) return true;
  if (value.type === 'cast') return isLiteral(value.operand);
  if (value.type === 'array') return Array.isArray(value.expressions) && value.expressions.every(isLiteral);
  return false;
}

function validateCheckExpression(expression) {
  visit(expression, (node) => {
    if (node.type === 'call' || node.type === 'select' || node.type === 'with') throw new Error('Functions and subqueries are not allowed in schema CHECK constraints.');
    if (node.type === 'ref' && (node.table || node.schema)) throw new Error('Qualified column references are not allowed in schema CHECK constraints.');
    if (node.type === 'binary' && !checkOperators.has(String(node.op).toLowerCase())) throw new Error('This operator is not allowed in schema CHECK constraints.');
  });
}

export function validateSetupSql(schemaSql, dataSql) {
  const schemaStatements = parseStatements(schemaSql, 'Schema');
  const dataStatements = parseStatements(dataSql, 'Sample data');
  if (!schemaStatements.length) throw new Error('Provide at least one CREATE TABLE statement.');
  if (schemaStatements.length > MAX_TABLES || dataStatements.length > MAX_SETUP_STATEMENTS) throw new Error('Schema setup contains too many statements.');

  const tables = [];
  for (const statement of schemaStatements) {
    if (statement.type !== 'create table' || statement.name?.schema || statement.temporary || statement.unlogged || statement.as) {
      throw new Error('Schema setup supports only ordinary, unqualified CREATE TABLE statements.');
    }
    const tableName = statement.name?.name;
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(String(tableName ?? ''))) throw new Error('A table name is not a valid PostgreSQL identifier.');
    if (!Array.isArray(statement.columns) || !statement.columns.length || statement.columns.length > MAX_COLUMNS) throw new Error(`Table ${tableName} has an unsupported number of columns.`);
    if (tables.some((table) => table.toLowerCase() === tableName.toLowerCase())) throw new Error(`Duplicate table definition: ${tableName}.`);

    for (const column of statement.columns) {
      if (column.kind !== 'column') throw new Error('Table-level constraints are not supported; define constraints on individual columns.');
      if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(String(column.name?.name ?? ''))) throw new Error('A column name is not a valid PostgreSQL identifier.');
      if (column.dataType?.schema || column.dataType?.name?.schema) throw new Error('Schema-qualified column types are not allowed in the sandbox.');
      for (const constraint of column.constraints ?? []) {
        if (!allowedConstraints.has(constraint.type)) throw new Error(`The ${constraint.type} column constraint is not supported.`);
        if (constraint.type === 'reference' && constraint.foreignTable?.schema) throw new Error('Foreign keys must reference a table in this sandbox without a schema prefix.');
        if (constraint.type === 'default' && !isLiteral(constraint.default)) throw new Error('Column defaults must be literal values; functions are not allowed.');
        if (constraint.type === 'check') validateCheckExpression(constraint.expr);
      }
    }
    tables.push(tableName);
  }

  let seedRowCount = 0;
  for (const statement of dataStatements) {
    if (statement.type !== 'insert' || statement.into?.schema || statement.insert?.type !== 'values' || statement.onConflict || statement.returning) {
      throw new Error('Sample data supports only INSERT INTO table VALUES with literal values.');
    }
    if (!tables.some((table) => table.toLowerCase() === String(statement.into?.name ?? '').toLowerCase())) throw new Error('Sample data may insert only into a table defined by this schema.');
    if (statement.insert.values.some((row) => row.some((value) => !isLiteral(value)))) throw new Error('Sample data inserts may contain only literal values, not functions or expressions.');
    seedRowCount += statement.insert.values.length;
    if (seedRowCount > MAX_SEED_ROWS) throw new Error('Sample data exceeds the 2,000-row sandbox limit.');
  }

  return { tables };
}

function assertReadOnlyStatement(statement, depth = 0) {
  if (depth > 20) throw new Error('The query has nested CTEs beyond the sandbox limit.');
  if (statement.type === 'with') {
    if (!Array.isArray(statement.bind) || statement.bind.length > 20) throw new Error('A query may contain at most 20 CTEs.');
    for (const binding of statement.bind) assertReadOnlyStatement(binding.statement, depth + 1);
    return assertReadOnlyStatement(statement.in, depth + 1);
  }
  if (statement.type !== 'select') throw new Error('Only read-only SELECT queries are allowed in the sandbox.');
  if (statement.into || statement.for || statement.locking) throw new Error('SELECT INTO and row-locking clauses are disabled in the sandbox.');
  assertUnqualifiedObjects(statement);
  assertAllowedFunctions(statement);
}

export function validateLearnerQuery(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 40_000) throw new Error('Enter a query under 40,000 characters.');
  const statements = parseStatements(sql, 'Query');
  if (statements.length !== 1) throw new Error('Run exactly one SQL statement at a time.');
  assertReadOnlyStatement(statements[0]);
  return sql.trim().replace(/;\s*$/, '');
}
