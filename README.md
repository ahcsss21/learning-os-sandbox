# Learning OS

Learning OS is an SQL practice app built around assisted independence: learners write and run their own queries, receive contextual progressive hints, and can later practice in no-help mode.

## Live Demo

Production URL: https://learning-os-sandbox.vercel.app

## Repository

https://github.com/ahcsss21/learning-os-sandbox

## Run locally

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env.local` and fill in your Supabase project URL and publishable key.
3. Install dependencies with `npm ci`.
4. Start the app with `npm run dev -- --host 127.0.0.1`.

Tester access is checked server-side against the `TESTER_EMAILS` Supabase Function secret; tester addresses are not included in the frontend bundle. Never put a service-role key in a Vite variable.

## Production deployment

The project is configured for Vercel. Import this repository into a Vercel project and set these production environment variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- Set the server-only Supabase Function secret `TESTER_EMAILS` to the comma-separated tester email list. In Supabase Authentication URL Configuration, allow the deployed site URL for redirects, including password recovery. Deploy the frontend after setting its environment variables.

Supabase Edge Functions and database migrations are managed separately. Apply pending migrations with `npx supabase db push` and deploy changed functions with `npx supabase functions deploy <function-name>` from the project root.

Question and hint generation use an OpenAI-compatible chat completions provider. Set these server-only Supabase Function secrets: `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`. Reasoning models such as `openai/gpt-oss-20b` default to low reasoning effort so hidden reasoning does not exhaust the completion budget; override with the optional `LLM_REASONING_EFFORT` secret. The shared client retries rate limits using the provider's advised delay.

The SQL sandbox is a separate Docker service (`sandbox-service`), deployed on Render in the current setup. Redeploy it whenever its SQL allowlist changes.

## Architecture

- React and Vite frontend
- Supabase Auth and owner-scoped Data API records
- Supabase Edge Functions for question generation, hints, query evaluation, schema save, and tester-authored sets
- Restricted PostgreSQL sandbox service for validation and query execution
- Private reference SQL and expected results stored in `practice_question_keys`

## Question difficulty

Generated questions are validated against their reference SQL in the sandbox, and the requested level is checked from the SQL structure rather than the model's own label:

- **Low:** single table or one join; no `GROUP BY`/`HAVING`, window functions, CTEs, or subqueries.
- **Medium:** ordinary combinations such as a join with one aggregation level, or one simple subquery or CTE. A derived-table aggregate (for example, count per member then average per city) is medium.
- **High:** a window function, a CTE chain of at least three `SELECT` blocks, or a subquery compared against an aggregate, plus at least two distinct aggregate/window functions.

Failed candidates are repaired with the specific rule they broke. The checks are regex-based on the SQL text, not a full parser, so edge cases can be misclassified.

## Checks

```powershell
npm ci
npm run build
npm test --prefix sandbox-service
```

## Evaluation status

The evidence is reported in three separate activities: two-person manual discovery, a pre-final-app review of six learner capture profiles, and three post-build app/baseline task-set rounds. These are exploratory observations, not one controlled study. The current artifacts do not establish the C7 requirement of a six-or-more learner baseline-versus-removal comparison with a complete, consistently scored held-out dataset. See `CASE_STUDY.md` for outcomes and limitations.

The demonstration talk track is maintained separately from the public repository.
