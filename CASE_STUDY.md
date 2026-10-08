# Learning OS: Assisted Independence for SQL Practice

## Case study summary

Learning OS is a SQL practice application built around a simple question: can an assistant help a learner make progress without taking over the reasoning? Instead of returning a finished query, the app runs the learner's SQL, identifies whether the query failed or returned the wrong result, and offers a contextual hint. A separate no-help mode is intended to test whether the learner can later solve a new task independently.

This case study separates three activities: the two-person manual coaching experiment, a pre-app review of six learners' SQL captures, and post-build app/baseline task-set rounds. It is exploratory product evidence, not a controlled efficacy study. Participant names and contact details are omitted. Raw transcripts and screenshots remain in the private research workspace.

## The problem

A SQL learner can be blocked for very different reasons: choosing the wrong table, mistyping a field, using a database value that does not exist, misunderstanding a join, aggregating at the wrong level, or writing a valid query with the wrong output. A generic answer or repeated hint can obscure which problem is actually present. The product hypothesis was that timely, error-specific hints could preserve learner agency while still making practice usable.

## Discovery and experiments

These are three distinct activities, not one continuous controlled study. The early manual sessions informed the idea; the six-learner review informed the pre-final-app design; the post-build rounds captured app and ordinary-chatbot use. Their outcomes are reported separately.

| Activity | Cohort and protocol | Main observations | Outcome and evidence limit |
|---|---|---|---|
| 1. Manual discovery | Two learners, one experienced and one SQL beginner; facilitator-led practice followed by next-day no-help questions. | The beginner needed schema/value and query-planning support; the experienced learner had analytical intent but hit aggregation, scope, and dialect errors. | 1/2 held-out results correct. The two tasks differed by learner level; this is discovery evidence, not a condition comparison. |
| 2. Pre-app six-learner review | Six profiles (L1-L3 beginner, L4-L5 advanced, L6 intermediate); retrospective review of query/error/result captures before the final app. | Issues varied by level and query state: exact values and joins, duplicate grain, grouping/rounding, alias scope, window syntax, and product/evaluator defects. | Produced the error taxonomy and product requirements. No complete six-person held-out score or condition assignment is available in the shareable workspace. |
| 3. Post-build app/baseline rounds | Six learners split between app and ordinary-chatbot baseline (3 per condition), across three task-set rounds; all six have held-out captures. | App hints sometimes targeted grouping, aliases, or rounding; baseline use ranged from full-query generation to debugging and conceptual explanation. | App held-out: 2/3 correct, 1 unfinished. Baseline held-out: 0/3 correct; all three were adjudicated incorrect. |

### Activity 1: Two-person manual discovery (13-14 September 2026)

An experienced software engineer and a SQL beginner worked with a facilitator over Google Meet and a shared SQL editor. The facilitator observed each attempt and gave progressively more specific hints without immediately supplying the final query. The beginner needed help mapping plain language to tables, columns, exact values, joins, and operations. The experienced learner generally understood the analytical goal but encountered aggregation placement, alias scope, query structure, and PostgreSQL dialect problems.

Two questions intended to be held out were accidentally used during coaching and were excluded from transfer scoring. On the next day, each learner attempted a different unseen task without help: the experienced learner's result was correct; the beginner's first result omitted the Hyderabad filter and was incorrect. This is 1/2 on two different level-matched tasks, not a comparative effect estimate. The final hackathon report and private contact/held-out evidence document this activity.

### Activity 2: Six-learner pre-final-app capture review

Before the final app, capture notes were reviewed for six learner profiles: L1-L3 beginner, L4-L5 advanced, and L6 intermediate. The review was organized by learner and question, and it focused on what the query/error/result revealed and what the product should do next:

| Profile | Observed pattern in the capture review | Product implication |
|---|---|---|
| L1, beginner | Misspelled table names, a faulty join key, and sort errors; some follow-up hints no longer matched the changed query. | Re-diagnose the latest attempt; resolve schema names and join keys before moving to ordering. |
| L2, beginner | Column typos and guessed status values; duplicate customer rows violated the requested one-row-per-customer grain. The prototype also rejected a result with columns in a different order. | Use exact schema/data evidence, explain row grain, and avoid treating projection order as incorrect when the contract does not require it. |
| L3, beginner | Case-sensitive status and boundary mistakes, a rejected trailing semicolon, a schema-resolution defect, and a missed tie-break sort. | Separate learner errors from parser/evaluator defects; make boundaries, schema selection, and tie rules explicit. |
| L4, advanced | Ranked order rows where customer totals were required; CTE alias/scope problems; averaged order amounts instead of customer totals. | Validate aggregation grain before ranking and diagnose scope at the active query block. |
| L5, advanced | The prompt omitted a field required by the hidden output contract; other attempts had grouping-grain problems and repetitive hints. | Keep prompt and answer contract aligned; make hints depend on the latest query. |
| L6, intermediate | Basic filters and joins sometimes worked; a relationship/filter issue produced an incomplete or wrong result. The capture set was smaller. | Distinguish expected order-level rows from duplicate people and keep conclusions about this profile tentative. |

This is a retrospective capture review, not a randomized baseline-versus-app trial. The build-review document contains the six-profile synthesis, while the question bank and expected-results file describe planned tasks and answer keys. The underlying `L1`-`L6` folders are empty in this shareable workspace, so individual event logs, complete outcomes, and a six-person accuracy rate cannot be independently reconstructed here.

### Activity 3: Post-build app and baseline task-set rounds

Six learners were split into two conditions, three using the app and three using an ordinary-chatbot baseline. The three task-set rounds used library, employee/time-sheet, and course/enrollment schemas; each round has an app and baseline practice record and a held-out capture for each condition. The captures establish the six-person removal run. The available package does not preserve names or a complete assignment/experience-stratification sheet, so the condition split is reported as 3/3 without claiming randomization.

| Task-set round | App practice evidence | App no-help held-out evidence | Baseline evidence and caveat |
|---|---|---|---|
| Library | 3/3 questions matched expected output after 4, 5, and 19 attempts; two and three hint markers were recorded on questions 2 and 3. | Correct after 4 attempts, with no hints. | Practice captures show ChatGPT supplying full SQL after a grouping error and helping debug other queries. Held-out query failed with a syntax error before returning results. |
| Employees/time sheets | 2/3 questions have a recorded matching result after 1 and 4 attempts. The third ends after attempt 4 without a matching-result marker. | Correct after 6 attempts, with no hints. | Practice captures show ChatGPT diagnosing missing rounding and supplying a `ROUND` expression. Held-out result is unrounded despite the two-decimal requirement, so it misses the stated contract. |
| Courses/enrollments | 3/3 questions matched expected output after 3, 2, and 18 attempts; five hint markers appear on the longest task. | Still in progress after 4 attempts, with no hints. | Practice captures show query-check and conceptual-explanation requests. The baseline held-out query returned `Pune | 1500.00`, but was scored incorrect against the held-out task's required result. |

Across the three app practice logs, 8/9 tasks have an explicit successful-result marker. All six held-out captures are present: the app condition has 2/3 correct and one unfinished; the baseline condition has 0/3 correct. These are descriptive outcomes from three learners per condition, not a reliable effect estimate. Preserve the per-learner scoring and task records when presenting the comparison.

The post-build observations still informed product changes: hints need to target the latest unresolved issue, the result contract must specify fields/order/precision, and a technically valid query is not necessarily a correct result. They do not establish that the app caused better learning or transfer.

## Product response

The application evolved from manual coaching into an authenticated React/Supabase platform with a restricted PostgreSQL sandbox. It now supports schema storage and inspection, generated questions validated against reference queries, learner SQL attempts, deterministic result comparison, contextual hints, session history, and a no-help removal mode. Answer keys are kept server-side. A tester workflow can assign curated fixed questions to learner accounts after its allowlist is configured.

The architecture separates the roles emphasized in the C7 brief: human facilitators recruited learners, chose/assigned tasks, and delivered the early manual hints; probabilistic model calls propose questions and contextual hints; deterministic code authorizes access, executes read-only SQL in the restricted sandbox, validates generated reference queries, compares result sets, and enforces hint/no-help rules. The model does not decide whether an answer is correct; the automated evaluator compares results against server-side reference outputs. In the manual activity, the facilitator observed attempts and delivered hints without providing the final query.

The latest hint-policy implementation adds an explicit five-level support ladder, starting broad and becoming more specific only after a subsequent failed attempt on the same issue. It maps database errors and result mismatches to task concepts, records independent versus hint-assisted success per skill, and allows one hint per failed attempt. This is an implementation of the assisted-independence hypothesis, not yet proof that it improves retention.

Generated questions are labeled low, medium, or high, and early generations mislabeled difficulty, which would undermine any comparison across learners. The generator now states an explicit rubric and a server-side validator classifies each reference query from its SQL structure: low avoids grouping, windows, CTEs, and subqueries; medium is a join with one aggregation level or one simple subquery or CTE, including a derived-table aggregate; high needs a window function, a CTE chain of at least three SELECT blocks, or a subquery compared against an aggregate, plus at least two distinct aggregate or window functions. Failed candidates are sent back with the specific rule they broke.

## What we learned

1. **The failure type matters.** A missing column, wrong enum value, incorrect grouping grain, and wrong ordering need different next steps.
2. **The learner's latest attempt matters.** A hint should track what changed and target the remaining issue, rather than replaying an earlier diagnosis.
3. **Correctness feedback needs a trustworthy contract.** Prompts must specify output fields, duplicates, ordering, ties, and numeric precision consistently with the hidden evaluator.
4. **More help is not always better.** The coach should give one next step, wait for another attempt, and escalate only when the attempt shows the learner still needs help.
5. **A chatbot baseline is not one fixed behavior.** Learners choose whether to request explanations, debugging, or a complete query. That variation should be recorded and described, not erased by assuming all participants requested answers.
6. **Do not trust a model's self-reported metadata.** Requiring a minimum count of model-written reasoning steps rejected valid questions. Difficulty is now judged from the SQL, and the step list is descriptive only. The first structural rule also misclassified a two-stage derived aggregate as advanced, so the rules needed a test against the rubric's own examples.
7. **LLM integration needs operational handling.** A reasoning model returned empty output when hidden reasoning consumed the completion budget, the provider's token-per-minute limit returned HTTP 429, and the sandbox rejected the equivalent `substr` alias. Fixes were low reasoning effort, retries that honor the provider's delay, and a reviewed safe-function allowlist addition.

## Evidence and limitations

Participant feedback from the first activity is qualitative and summarized rather than quoted. It is self-report, not a measured learning gain. The six-profile activity is available as a retrospective synthesis; the individual capture folders and a complete learner-level event table are not in the shareable workspace. The later baseline/app records are three task-set rounds, not a documented randomized cohort: participant IDs, condition assignment, identical timing, and consistent baseline held-out scoring are missing.

The post-build activity includes six learners split across app and ordinary-chatbot conditions, with one held-out capture for each learner; it therefore evidences the C7 minimum-sample removal run. The app condition scored 2/3 correct with one unfinished; the baseline condition scored 0/3 correct. The third baseline result is scored incorrect based on the held-out task review, although its prompt is not visible in the image itself. These are small exploratory groups and do not support a causal claim or statistical significance.

### C7 deliverable check

| # | C7 required artifact | Evidence in this workspace | Status and caveat |
|---|---|---|---|
| 1 | Observation | Two-person report, L1-L6 capture review, and three app-flow records. | Present across three activities; keep cohorts and methods separate. |
| 2 | Impact metric | Activity 1: 1/2 held-out correct. Activity 3: app 2/3 correct, 1 unfinished; baseline 0/3 correct. | Six held-out outcomes are scored; report the small groups descriptively, without causal or significance claims. |
| 3 | Hypothesis | The case study and experiment specification describe progressive, error-specific hints and unaided transfer. | Present as a hypothesis, not a finding. |
| 4 | Two named users | `Learning_OS_Hackathon_Submission_Final.docx`. | Present in the local/private submission with consent; names are omitted from this public case study. |
| 5 | Contact artifact for each user | `person1ss.zip`, `person2ss.zip`, and timestamped screenshots. | Present locally; raw participant evidence is intentionally not committed publicly. |
| 6 | Interview notes for each user | Starting-point notes in the final report; `person2_chat.txt` preserves Karthik's chat. | Partial: Shravya's temporary Meet chat was lost. |
| 7 | Manual run and actual output for each user | Session archives, held-out screenshots, and the three post-build app-flow records. | Present, but capture completeness differs by activity. |
| 8 | One specific user reaction per user | Exact reactions are in the final report and feedback screenshots. | Present locally; paraphrases are not substituted for quotes here. |
| 9 | D/P/H process map | The final report contains the manual decision/process/human map; `learning_os_workflow.json` describes the app workflow. | Present in the local final report; the JSON is not a replacement for the manual D/P/H map. |
| 10 | What broke | Final report, L1-L6 capture review, and the defects described here. | Present; includes protocol, learner-query, prompt, evaluator, and app issues. |

| C7 evaluation criterion | What this package supports | Status |
|---|---|---|
| Six learners and a removal test against ordinary answer-giving AI | Post-build run split six learners 3/3 across conditions and includes six held-out captures. | Run evidenced and all outcomes scored. Preserve participant condition/experience records alongside the result table. |
| Human, probabilistic, deterministic architecture | Facilitator, model, and sandbox/evaluator responsibilities are separated in the product response above. | Addressed in the design; not evidence of efficacy. |
| Product quality and learning | App logs show end-to-end runs and concrete usability/evaluator issues; those observations led to hint, contract, and validation changes. Some production workflows remain unverified. | Partial; report specific defects and avoid claiming a fully validated release. |

## Next evaluation

Present the six per-learner outcomes with condition, task, correctness, attempts, time, and completion status, alongside the held-out screenshots. Preserve experience-band and assignment details where available. Treat the current sample as exploratory; a larger, matched follow-up would be needed for a stronger estimate.

## Current project status

The core app and Edge Functions are implemented, including progressive hint support, curated question assignment, and structure-based difficulty validation. Supabase migrations and Edge Functions are deployed to the linked project, the frontend is hosted on Vercel at https://learning-os-sandbox.vercel.app, and the SQL sandbox runs as a separate service. An end-to-end live check of email password recovery, tester access, and learner assignment is still pending, so those flows should not be described as verified. Difficulty validation has been checked on sample queries but not against a large set of generations.
