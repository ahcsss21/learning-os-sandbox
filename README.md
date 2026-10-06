# Learning OS

Learning OS is an SQL practice app built around assisted independence: learners write and run their own queries, receive contextual progressive hints, and can later practice in no-help mode.

## Live Demo

Production URL: pending frontend hosting setup.

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

## Architecture

- React and Vite frontend
- Supabase Auth and owner-scoped Data API records
- Supabase Edge Functions for question generation, hints, query evaluation, schema save, and tester-authored sets
- Restricted PostgreSQL sandbox service for validation and query execution
- Private reference SQL and expected results stored in `practice_question_keys`

## Checks

```powershell
npm ci
npm run build
npm test --prefix sandbox-service
```

The case study is in `CASE_STUDY.md`. The demonstration talk track is maintained separately from the public repository.
