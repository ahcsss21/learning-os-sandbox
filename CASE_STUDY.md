# Learning OS: Assisted Independence for SQL Practice

## Case study summary

Learning OS is a SQL practice application built around a simple question: can an assistant help a learner make progress without taking over the reasoning? Instead of returning a finished query, the app runs the learner's SQL, identifies whether the query failed or returned the wrong result, and offers a contextual hint. A separate no-help mode is intended to test whether the learner can later solve a new task independently.

This case study combines the early manual discovery sessions, three later app/baseline/held-out task-set rounds, and the L1-L6 capture review. It is exploratory product evidence, not a controlled efficacy study. Participant names and contact details are omitted. Raw transcripts and screenshots remain in the private research workspace.

## The problem

A SQL learner can be blocked for very different reasons: choosing the wrong table, mistyping a field, using a database value that does not exist, misunderstanding a join, aggregating at the wrong level, or writing a valid query with the wrong output. A generic answer or repeated hint can obscure which problem is actually present. The product hypothesis was that timely, error-specific hints could preserve learner agency while still making practice usable.

## Discovery and experiments

### Early manual discovery

Two learners with contrasting backgrounds participated in the initial coached sessions. One had several years of software engineering experience; the other was a complete or near-complete SQL beginner. They used a food-delivery or e-commerce relational dataset in a shared SQL editor while a facilitator observed and gave hints. The novice needed help translating plain-language tasks into tables, columns, filters, and exact stored values. The more experienced learner often recognized the high-level analytical idea, but struggled with query structure, aggregation placement, alias scope, and PostgreSQL dialect differences.

An important protocol issue was discovered: two questions originally intended to be held out were used during a day-one session. They were reclassified as practice observations and were not treated as valid independent-transfer measurements.

### Later app, baseline, and held-out rounds

The workspace contains three later task-set rounds with app practice captures, baseline activity, and held-out artifacts. Baseline chatbot use was learner-directed: some learners asked for an explanation, some asked the chatbot to check their SQL, and some requested a complete query. This represents varied use of an ordinary chatbot; the evidence should not be described as if every baseline learner received the full answer.

Across the app walkthroughs, learners made progress through executable errors and result mismatches, but the number and type of retries varied. Captures show useful targeted clues for missing grouping and rounding, alongside weak spots: repeated alias advice after a query changed, vague result-mismatch feedback, and one multi-step aggregation task that remained difficult across many attempts. Held-out screenshots document attempts, but the available artifacts do not form a consistently scored, randomized dataset.

### L1-L6 capture review

The broader capture review reinforced several recurring failure categories:

- Beginners needed help locating the right table and field, using exact stored values, and understanding how tables connect.
- Duplicate rows often reflected a mismatch between row grain and the task requirement, not simply a missing keyword.
- Intermediate and advanced learners could have the right overall plan but struggle with grouping level, CTE scope, aliases, window-function syntax, or dialect support.
- Some apparent learner errors were product defects: ambiguous output contracts, overly strict column matching, confusing error presentation, and question wording that did not fully specify expected fields or precision.

## Product response

The application evolved from manual coaching into an authenticated React/Supabase platform with a restricted PostgreSQL sandbox. It now supports schema storage and inspection, generated questions validated against reference queries, learner SQL attempts, deterministic result comparison, contextual hints, session history, and a no-help removal mode. Answer keys are kept server-side. A tester workflow can assign curated fixed questions to learner accounts after its allowlist is configured.

The latest hint-policy implementation adds an explicit five-level support ladder, starting broad and becoming more specific only after a subsequent failed attempt on the same issue. It maps database errors and result mismatches to task concepts, records independent versus hint-assisted success per skill, and allows one hint per failed attempt. This is an implementation of the assisted-independence hypothesis, not yet proof that it improves retention.

## What we learned

1. **The failure type matters.** A missing column, wrong enum value, incorrect grouping grain, and wrong ordering need different next steps.
2. **The learner's latest attempt matters.** A hint should track what changed and target the remaining issue, rather than replaying an earlier diagnosis.
3. **Correctness feedback needs a trustworthy contract.** Prompts must specify output fields, duplicates, ordering, ties, and numeric precision consistently with the hidden evaluator.
4. **More help is not always better.** The coach should give one next step, wait for another attempt, and escalate only when the attempt shows the learner still needs help.
5. **A chatbot baseline is not one fixed behavior.** Learners choose whether to request explanations, debugging, or a complete query. That variation should be recorded and described, not erased by assuming all participants requested answers.

## Evidence and limitations

The participant feedback was qualitative and is summarized rather than quoted. One participant described the hints as useful and practice as engaging, while noting that some questions took time to finish. The novice described early SQL as overwhelming, then reported recalling basic patterns and benefiting from hints. These are self-reports, not measured learning gains.

The task sets were personalized and evolved across rounds. Baseline prompts and assistance varied by learner. The held-out artifacts are not all accompanied by standardized scoring records. The early sample was very small, and the existing capture review is not a randomized comparison. Therefore, the evidence supports design decisions and motivates further evaluation; it does not establish causal impact or statistical significance.

## Next evaluation

Use a fixed, reviewed question bank and frozen seed data. Match app and baseline tasks, schemas, time limits, and SQL execution. Allow natural chatbot use in the baseline and record whether the learner requests explanation, checking/debugging, or a complete query. In the app condition, preserve the progressive hint policy and log each hint level, SQL attempt, mismatch category, and time to first correct result. Follow training with a new no-help task, use a consistent scoring rubric, and report all learner-level outcomes as exploratory evidence.

## Current project status

The core app and Edge Functions are implemented, including progressive hint support and curated question assignment. Supabase migrations and Edge Functions are deployed to the linked project. The frontend still requires production hosting configuration and an end-to-end live check of email recovery, tester access, and learner assignment before a public project link can be claimed.
