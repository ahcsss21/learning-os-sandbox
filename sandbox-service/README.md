# Learning OS SQL sandbox service

The sandbox connects to Supabase Postgres with a restricted manager login. For each operation it opens a transaction, creates a unique temporary schema, loads only validated table DDL and literal seed rows, grants a no-login reader role access to that schema, runs learner SELECT statements as that reader role, and rolls back the transaction. No PGlite/WASM database is loaded, and learner SQL never executes as the manager.

The SQL parser intentionally supports a safe MVP subset: ordinary unqualified `CREATE TABLE`, literal `INSERT ... VALUES`, and one read-only `SELECT` or `WITH` query. Writes, qualified table/function references, dynamic DDL, expression-based seed inserts, known side-effect functions, multi-statements, and data-modifying CTEs are rejected.

## Run tests

From the repository root:

```powershell
npm test --prefix sandbox-service
```

The tests cover allowed DDL/seeds/queries and rejected cross-schema access, writes, side-effect functions, and multi-statements.

## One-time Supabase setup

1. In Supabase SQL Editor, run the contents of `supabase/migrations/003_learning_os_sandbox_roles.sql`. It creates `learning_os_sandbox_reader` and `learning_os_sandbox_manager`; the manager can create schemas but has no grants on app tables. The reader is granted access only to the temporary schema during a transaction.
2. Set a strong password for `learning_os_sandbox_manager` in SQL Editor, for example with `ALTER ROLE learning_os_sandbox_manager WITH PASSWORD 'replace-with-a-strong-password';`. Do not use the `postgres` password. Keep the password private and out of chat/source files; do not save the query as a shared snippet.
3. In Supabase **Connect**, choose the **Session pooler** connection string. Use the manager role username and its password. Store the completed URI as a Render environment variable named `SANDBOX_DATABASE_URL`. It must remain server-side. Use TLS (`sslmode=require`).
4. Keep `SANDBOX_SERVICE_TOKEN` configured in Render and the matching Supabase Function secret. Keep `SANDBOX_SERVICE_URL` pointed at the Render service.

The migration targets Supabase's default `postgres` database. Confirm the selected project/database before applying it. Do not grant the manager role access to app tables or the answer-key table.

## Deploy the service

The Render service should build the Dockerfile at `sandbox-service/Dockerfile` with the repository root as its build context. Add or update the `SANDBOX_DATABASE_URL` environment variable in Render, then deploy the new service code. The Node/Postgres worker uses far less memory than PGlite, so the service should fit a 512 MB instance; free-instance cold starts may still delay initial requests.

Check `https://YOUR-RENDER-URL/health` for service health. This does not test database credentials. The first authenticated schema validation or query tests the Postgres connection and restricted role.

## Local run

Set `SANDBOX_DATABASE_URL` and `SANDBOX_SERVICE_TOKEN` in the local PowerShell session, then run:

```powershell
$env:PORT = '8080'
npm run sandbox:dev
```

Do not print, paste into chat, or commit either secret. A hosted Supabase Edge Function cannot access a service running only on your computer unless an HTTPS tunnel is configured.
