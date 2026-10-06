# Learning OS App: Production Readiness Enhancements

Date: 6 October 2026

## Scope

This plan covers the Learning OS application only: learner experience, question generation and evaluation, hints, security, reliability, and release checks. It does not prescribe changes to any external chatbot workflow.

## Current Foundation

The app already has authenticated learner accounts, owner-scoped records, private answer keys, generated question sets validated by the SQL sandbox, query attempts and history, contextual hints, and a no-help removal mode. The sandbox now uses a restricted native PostgreSQL worker. The Groq JSON-validation fallback has also been deployed with `generate-questions`.

The following work improves reliability and makes the app safer and more useful to learners before a wider release.

## P0: Release Gates

| Enhancement | Implementation area | Acceptance check |
|---|---|---|
| Verify tenant isolation and answer-key privacy end to end. Confirm every learner-facing function checks ownership, row-level security is enabled for learner data, and answer keys remain server-only. | `supabase/functions/**`, `supabase/migrations/**` | With two test accounts, neither account can read, change, execute against, or infer the other's schemas, sessions, attempts, or keys. |
| Apply resource and abuse limits to expensive or untrusted operations: question/schema generation, query execution, and oversized payloads. Keep secrets exclusively in server-side function configuration. | `supabase/functions/_shared/platform.ts`, `supabase/functions/{generate-questions,generate-schema,run-query}/index.ts`, `sandbox-service/` | Requests have bounded time, payload, row count, and provider usage; timeouts and provider failures produce a recoverable learner-facing message. |
| Harden question-generation failure recovery. The deployed retry handles Groq `json_validate_failed`; count mismatches and invalid question objects still need a deliberate retry or clear failure path that never saves a partial set. | `supabase/functions/_shared/platform.ts`, `supabase/functions/generate-questions/index.ts` | Test provider rejection, malformed JSON, wrong question count, invalid reference SQL, and sandbox timeout. The learner either receives the full requested set or a clear retry option; no incomplete set is saved. |
| Verify evaluator contracts for aliases, duplicate rows, required ordering, NULLs, and numeric precision. Require every learner-visible output field and sort/rounding rule to agree with the hidden answer contract. | `supabase/functions/run-query/index.ts`, `supabase/functions/generate-questions/index.ts` | Regression fixtures cover each contract case; valid equivalent SQL is accepted and incorrect result sets are rejected without revealing expected rows. |
| Establish a repeatable deployment and smoke-test gate for the frontend, Edge Functions, migrations, and sandbox. | `package.json`, `sandbox-service/package.json`, `supabase/` | Production release passes the frontend build, sandbox safety tests, Edge Function type/bundle checks, migration review, and authenticated end-to-end smoke test. |

## P1: Learning Quality

| Enhancement | Implementation area | Acceptance check |
|---|---|---|
| Enforce one hint per failed attempt. Disable the hint action until the learner runs a new attempt, and enforce the rule in the function/database so direct API calls cannot bypass it. | `src/main.jsx`, `supabase/functions/generate-hint/index.ts`, `supabase/migrations/002_learning_os_platform.sql` | A second hint for the same attempt is rejected; a new attempt enables one new hint. Historical hints remain visible and are associated with their attempt. |
| Make hint progression explicit: attention, location, concept, structure, mechanism. Diagnose the latest unresolved issue and avoid repeating the same idea after the learner changes their query. | `supabase/functions/generate-hint/index.ts` | Replay captured error/result cases; each hint addresses the latest failure, is concise, gives one next step, and never returns the complete query, reference SQL, or expected rows. |
| Improve value-mismatch diagnosis using only learner-visible evidence. The hint function currently receives result columns, row count, and mismatch category, but not enough detail to distinguish many wrong-value cases. Send a bounded, privacy-conscious summary of the learner's actual result; never send the hidden expected result. | `supabase/functions/generate-hint/index.ts`, `supabase/functions/run-query/index.ts` | Representative value, row-count, ordering, and column failures produce distinct and relevant hints without exposing answer-key data. |
| Replace raw, lengthy parser diagnostics in the primary result panel with a short explanation and an expandable technical detail view. Preserve the exact error for debugging and learner inspection. | `src/main.jsx` (`ResultPanel`), `src/styles.css` | Long parser errors remain readable on mobile and desktop; no-help mode still withholds correctness feedback until final submission. |
| Improve question clarity and contract consistency. In particular, use accurate field names and explicitly state output grain, required fields, duplicate behavior, sorting/tie rules, and numeric rounding. | `supabase/functions/generate-questions/index.ts`, question-generation validation | A question review checklist or automated validator flags missing output requirements and ambiguous wording before the question is saved. |

## P2: Study and Learner Workflow

| Enhancement | Implementation area | Acceptance check |
|---|---|---|
| Add a tester-controlled question-set authoring/import path for curated tasks and hidden keys. Keep answer keys inaccessible to learner clients and freeze a set once a session starts. | Tester-facing UI/API, `supabase/functions/**`, `supabase/migrations/**` | A tester can create, validate, assign, and version a set; learners can only access the prompt and output contract. Sessions continue to use the same frozen set. |
| Record learner task duration separately from query execution duration. The current attempt `elapsed_ms` measures the sandbox call, not the learner's working time. | `src/main.jsx`, `supabase/functions/run-query/index.ts`, `supabase/migrations/002_learning_os_platform.sql` | Each task has start/end timestamps; query execution latency remains a separate metric. Reloads and abandoned tasks are represented accurately. |
| Make question generation and session setup easier to recover from: retain form selections after provider errors, show requested versus generated count where safe, and offer a retry without silently creating duplicate sets. | `src/main.jsx`, `src/platformApi.js`, `supabase/functions/generate-questions/index.ts` | A transient failure does not erase the learner's setup; retry creates at most one complete set and clearly reports its state. |

## Recommended Order

1. Complete the P0 security, resource-limit, evaluator, and release checks.
2. Enforce one hint per attempt and validate progressive hint behavior against recorded cases.
3. Improve question-contract clarity and error presentation.
4. Add tester-controlled fixed sets and learner-time tracking if the app will support structured evaluations.

## Release Verification

- Run `npm run build`.
- Run `npm test --prefix sandbox-service`.
- Run Edge Function type/bundle checks in an environment with the Supabase CLI and Deno available.
- Verify migrations against the intended Supabase project before applying them.
- Smoke-test signup/sign-in, schema save/validation, question generation, correct and incorrect SQL, hints, history, and no-help final submission with a test account.
- Confirm function secrets, sandbox credentials, TLS verification, provider limits, and logs contain no learner credentials or answer keys.

## Out of Scope

This document does not change or standardize any external chatbot behavior. It records enhancements to the Learning OS application itself.