# Confirm the eligible ticket-reply subset

User-approved policy, 22 October 2026. This is separate from resolver and embedding improvements.

For a requested ticket-reply batch, check known eligibility without sending. If A is eligible but B has no email address, the existing approval card explains B's blocker and previews A's actual recipient/body. Ask whether to proceed with only the eligible actions. Cancel sends nothing; approve sends the eligible subset and reports the blocked targets as failures, so the final status is partial. If all targets are blocked, explain the failures without an empty approval.

Implementation uses an optional side-effect-free action preflight, currently implemented by Reply to ticket requester. Permissions, ticket state, linked-contact identity and address validity share checks with execution. It never invokes delivery, consumes injected faults, creates messages or advances SLA. Eligibility is not a delivery guarantee: provider failures can still occur after approval and are reported normally.

The executor supports a single-call forEach and consecutive independent preflight-capable action steps whose arguments are already available. It does not speculate about prerequisites produced by earlier writes, or dry-run multi-call transactions (for example reopen then reply). Those retain the existing execution/approval semantics. Independent action batches and forEach previews bind both eligible recipients and blocked targets to the plan approval. Changes to recipients or eligibility require renewed approval before sends. Completed writes remain replay-deduplicated. Confirmation resumes the saved plan without another LLM call.

The planner is instructed to include requested ticket replies rather than inventing an address, relinking a requester, or substituting a free-text clarification for the app's approval. Invalid plans still fail validation; this change does not solve general reference construction or identity matching.

The old frozen module seed, development/reporting scenarios and historical results are unchanged. New policy cases live in `eval/policy-scenarios/partial-confirmation/`, with explicit confirmation-content assertions so a final partial status alone cannot count as success. Approve and decline are separate cases. These are development policy checks, not a fresh reporting holdout or a replacement for full-suite acceptance.
