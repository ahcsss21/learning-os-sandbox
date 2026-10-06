import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLearnerQuery, validateSetupSql } from './sql-safety.mjs';

test('accepts local table DDL and literal seed rows', () => {
  const result = validateSetupSql(
    'CREATE TABLE customers (id integer PRIMARY KEY, name text); CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer REFERENCES customers(id), amount numeric(10,2) CHECK (amount >= 0));',
    "INSERT INTO customers VALUES (1, 'Asha'); INSERT INTO orders VALUES (1, 1, 10.50);",
  );
  assert.deepEqual(result.tables, ['customers', 'orders']);
});

test('rejects schema changes outside the temporary namespace', () => {
  assert.throws(() => validateSetupSql('CREATE SCHEMA public;', ''), /ordinary, unqualified CREATE TABLE/);
  assert.throws(() => validateSetupSql('CREATE TABLE public.customers (id integer);', ''), /ordinary, unqualified CREATE TABLE/);
  assert.throws(() => validateSetupSql('CREATE TABLE customers (id public.secret_type);', ''), /Schema-qualified column types/);
  assert.throws(() => validateSetupSql('CREATE TABLE customers (id integer DEFAULT nextval(\'s\'));', ''), /defaults must be literal/);
});

test('rejects non-literal or mutating seed SQL', () => {
  assert.throws(() => validateSetupSql('CREATE TABLE items (id integer);', 'INSERT INTO items VALUES (nextval(\'s\'));'), /only literal values/);
  assert.throws(() => validateSetupSql('CREATE TABLE items (id integer);', 'INSERT INTO items VALUES (1) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id;'), /only INSERT INTO table VALUES/);
});

test('accepts read-only joins, aggregates, CTEs, and windows', () => {
  assert.ok(validateLearnerQuery('SELECT c.city, count(o.id) AS orders FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.city ORDER BY orders DESC'));
  assert.ok(validateLearnerQuery('WITH ranked AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM orders) SELECT id FROM ranked WHERE rn = 1'));
  assert.ok(validateLearnerQuery("SELECT substr('learning', 1, 3) AS prefix"));
});

test('rejects writes, cross-schema reads, and data-modifying CTEs', () => {
  assert.throws(() => validateLearnerQuery('DELETE FROM orders'), /Only read-only SELECT/);
  assert.throws(() => validateLearnerQuery('SELECT * FROM public.learning_schemas'), /Schema-qualified table names/);
  assert.throws(() => validateLearnerQuery('WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone'), /Only read-only SELECT/);
  assert.throws(() => validateLearnerQuery('SELECT 1; SELECT 2'), /exactly one SQL statement/);
});

test('rejects functions with side effects or resource abuse', () => {
  assert.throws(() => validateLearnerQuery('SELECT pg_sleep(10)'), /pg_sleep function is not allowed/);
  assert.throws(() => validateLearnerQuery('SELECT nextval(\'orders_id_seq\')'), /nextval function is not allowed/);
  assert.throws(() => validateLearnerQuery("SELECT set_config('search_path', 'public', true)"), /set_config function is not allowed/);
  assert.throws(() => validateLearnerQuery('SELECT query_to_xml(\'select * from public.learning_schemas\', true, false, \'\')'), /query_to_xml function is not allowed/);
  assert.ok(validateLearnerQuery('SELECT round(avg(amount), 2), count(*) FROM orders'));
});
