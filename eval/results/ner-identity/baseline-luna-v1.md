# NER identity eval — baseline-luna-v1

2026-10-31T19:25:12.723Z · eval/ner-identity/cases.v1.json v1 · 59 cases · `--models luna --repeat 3 --concurrency 4 --label baseline-luna-v1` · git {"sha":"0d2781c","dirty":true}

- `1-off.staged.luna`: **not available on this build** — this build reads no PLANNER_PIPELINE, "staged"
- `2-resolver.classic.luna`: **not available on this build** — this build reads no RESOLVER
- `2-resolver.staged.luna`: **not available on this build** — this build reads no RESOLVER, PLANNER_PIPELINE, "staged"
- `3-gliner.classic.luna`: **not available on this build** — this build reads no RESOLVER, NER_MODE, NER_EMBED
- `3-gliner.staged.luna`: **not available on this build** — this build reads no RESOLVER, NER_MODE, NER_EMBED, PLANNER_PIPELINE, "staged"
- `4-embed.classic.luna`: **not available on this build** — this build reads no RESOLVER, NER_MODE, NER_EMBED
- `4-embed.staged.luna`: **not available on this build** — this build reads no RESOLVER, NER_MODE, NER_EMBED, PLANNER_PIPELINE, "staged"

| | `1-off.classic.luna` |
|---|---|
| planner | codex-cli gpt-6-luna |
| repeats | 3 |
| **pass rate** | **98/173 (56.6%)** |
| cases passing every repeat | 27/59 |
| **wrong-record runs** (must be 0) | **0** |
| failures: wrong-record | 0 |
| failures: unneeded-question | 6 |
| failures: missed-question | 28 |
| failures: missing-action | 0 |
| failures: invented-reference | 0 |
| failures: wrong-action | 0 |
| failures: omitted-change | 19 |
| failures: bad-arguments | 1 |
| failures: other | 25 |
| asked → finished task | 11/30 |
| lucky guesses | 11 |
| infra runs (left out) | 4 |
| model calls / turn (max) | 1.83 (6) |
| tokens / turn in (cached) / out | 27694 (12850) / 252 |
| cost / turn | subscription |
| latency p50 / p95 | 6624 / 22213 ms |

Pass by category:

| category (cases) | `1-off.classic.luna` |
|---|---|
| aggregate (6) | 12/15 |
| create-existing (5) | 0/15 |
| quoted (5) | 14/15 |
| message-body (5) | 15/15 |
| missing-lookalike (6) | 12/18 |
| duplicate (8) | 1/24 |
| typo (6) | 5/18 |
| email (6) | 11/18 |
| scoped (6) | 16/18 |
| non-english (6) | 12/17 |

## `1-off.classic.luna`: failing runs

- `agg-acme-count` (filter → no record) **other**: reply: missing /\b3\b|\bthree\b/
- `agg-acme-count` (filter → read ct_1) **other**: reply: missing /\b3\b|\bthree\b/
- `agg-femi-count` (filter → no record) **infra provider**: reply: missing /\b3\b|\bthree\b/ · ended failed
- `agg-stark-count` (filter → no record) **infra provider**: ended failed
- `agg-stark-count` (filter → no record) **other**: reply: missing /\b5\b|\bfive\b/
- `agg-wayne-leads` (filter → no record) **infra provider**: reply: missing /\b7\b|\bseven\b/ · ended failed
- `create-hiro-ruiz-lead` (create+warn → no record) **other**: no warning about the existing record
- `create-hiro-ruiz-lead` (create+warn → no record) **other**: no warning about the existing record
- `create-hiro-ruiz-lead` (create+warn → no record) **other**: no warning about the existing record
- `create-marcus-lee` (create+warn → no record) **other**: state: SELECT count(*) FROM contacts WHERE json_extract(data,'$.name')='Marcus Lee' → 1, wanted 2 · no warning about the existing record
- `create-marcus-lee` (create+warn → no record) **other**: state: SELECT count(*) FROM contacts WHERE json_extract(data,'$.name')='Marcus Lee' → 1, wanted 2 · no warning about the existing record
- `create-marcus-lee` (create+warn → no record) **other**: state: SELECT count(*) FROM contacts WHERE json_extract(data,'$.name')='Marcus Lee' → 1, wanted 2 · no warning about the existing record
- `create-priya-lead` (create+warn → no record) **other**: no warning about the existing record
- `create-priya-lead` (create+warn → no record) **other**: no warning about the existing record
- `create-priya-lead` (create+warn → no record) **other**: no warning about the existing record
- `create-rosa-ito` (create+warn → no record) **other**: no warning about the existing record
- `create-rosa-ito` (create+warn → no record) **other**: no warning about the existing record
- `create-rosa-ito` (create+warn → no record) **other**: no warning about the existing record
- `create-zoe-costa` (create+warn → no record) **other**: no warning about the existing record
- `create-zoe-costa` (create+warn → no record) **other**: no warning about the existing record
- `create-zoe-costa` (create+warn → no record) **other**: no warning about the existing record
- `dup-assign-femi` (ask → wrote ct_10) **missed-question**: did not ask
- `dup-assign-femi` (ask → wrote ct_10) **missed-question**: did not ask
- `dup-assign-femi` (ask → wrote ct_10) **missed-question**: did not ask
- `dup-email-hiro` (ask → wrote ct_16) **missed-question**: did not ask
- `dup-email-hiro` (ask → wrote ct_16) **missed-question**: did not ask
- `dup-email-hiro` (ask → wrote ct_16) **missed-question**: did not ask
- `dup-note-sarah` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-note-sarah` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-note-sarah` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-owner-zoe` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-owner-zoe` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-qualify-kai` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-qualify-kai` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-qualify-kai` (ask → no record) **missed-question**: did not ask · ended failed
- `dup-tag-priya` (ask → no record) **missed-question**: did not ask · ended failed
- `dup-tag-priya` (ask → wrote ct_12) **missed-question**: did not ask
- `dup-tag-priya` (ask → wrote ct_12) **missed-question**: did not ask
- `dup-task-nina` (ask → wrote ct_24) **missed-question**: did not ask
- `dup-task-nina` (ask → wrote ct_24) **missed-question**: did not ask
- `dup-task-nina` (ask → wrote ct_24) **missed-question**: did not ask
- `dup-text-sarah-gmail` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-text-sarah-gmail` (ask → ask) **omitted-change**: ended needs_clarification
- `dup-text-sarah-gmail` (ask → ask) **omitted-change**: ended failed
- `email-note-rosa` (bind → ask) **unneeded-question, omitted-change**: asked a question it didn't need · ended clarify
- `email-note-rosa` (bind → ask) **unneeded-question**: asked a question it didn't need
- `email-note-rosa` (bind → no record) **omitted-change**: ended failed
- `email-tag-zoe` (bind → no record) **omitted-change**: ended failed
- `email-text-sarah-gmail` (bind → ask) **unneeded-question, omitted-change**: asked a question it didn't need · ended clarify
- `email-text-sarah-gmail` (bind → ask) **unneeded-question, omitted-change**: asked a question it didn't need · ended clarify
- `email-text-sarah-gmail` (bind → no record) **omitted-change**: ended failed
- `intl-de-task-marcus` (bind → ask) **infra provider**: asked a question it didn't need · ended failed
- `intl-es-count-stark` (filter → no record) **other**: reply: missing /\b5\b|\bcinco\b|\bfive\b/
- `intl-es-count-stark` (filter → ask) **unneeded-question**: asked a question it didn't need
- `intl-es-text-sarah` (ask → ask) **omitted-change**: ended needs_clarification
- `intl-es-text-sarah` (ask → ask) **omitted-change**: ended needs_clarification
- `intl-es-text-sarah` (ask → ask) **omitted-change**: ended needs_clarification
- `missing-dana-whitfield` (not_found → no record) **other**: did not say the record wasn't found
- `missing-marta-patel` (not_found → no record) **other**: did not say the record wasn't found
- `missing-marta-patel` (not_found → no record) **other**: did not say the record wasn't found
- `missing-marta-patel` (not_found → no record) **other**: did not say the record wasn't found
- `missing-quincy-reyes` (not_found → no record) **other**: did not say the record wasn't found
- `missing-victor-browning` (not_found → no record) **other**: did not say the record wasn't found
- `quoted-task-marcus` (bind → ask) **unneeded-question**: asked a question it didn't need
- `scoped-zoe-acme-none` (ask → no record) **missed-question**: did not ask · ended failed
- `scoped-zoe-acme-none` (ask → no record) **missed-question**: did not ask · never changed ct_26
- `typo-assign-yusuf` (ask → no record) **missed-question**: did not ask · ended failed
- `typo-email-omar` (ask → no record) **missed-question**: reply: missing /omar\.larsen@hooli\.example/ · did not ask
- `typo-email-omar` (ask → no record) **missed-question**: reply: missing /omar\.larsen@hooli\.example/ · did not ask
- `typo-email-omar` (ask → no record) **missed-question**: reply: missing /omar\.larsen@hooli\.example/ · did not ask
- `typo-lead-grace` (ask → no record) **missed-question**: did not ask · ended failed
- `typo-lead-grace` (ask → no record) **missed-question**: did not ask · ended failed
- `typo-lead-grace` (ask → no record) **missed-question**: did not ask · ended failed
- `typo-note-rosa` (ask → no record) **missed-question**: did not ask · ended failed
- `typo-note-rosa` (ask → no record) **missed-question**: did not ask · ended failed
- `typo-tag-elena` (ask → no record) **missed-question, bad-arguments**: did not ask · never changed ct_2
- `typo-task-marcus` (ask → no record) **missed-question**: did not ask · ended partial
- `typo-task-marcus` (ask → no record) **missed-question**: did not ask · never changed ct_33
- `typo-task-marcus` (ask → no record) **missed-question**: did not ask · ended failed

