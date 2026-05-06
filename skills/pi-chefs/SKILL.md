# pi-chefs

You can consult expert Pi sessions ("chefs") that specialize in narrow domains. Each chef runs in its own Pi session with its own context, skills, and tools. Use them when a question is genuinely outside your zone of expertise — or when pulling in a domain skill would poison your context with investigation noise.

## When to use

**Yes:**
- The user asks a data question (BigQuery, dashboards, metrics) and you don't already have the data tools loaded → consult `chef-data`.
- You need to know what's in a specific Shopify table without taking on Data Portal as one of your skills.
- The investigation will involve many tool calls, but the answer fits in a paragraph.

**No:**
- You can answer in 1-2 turns with the tools you already have.
- The question is open-ended or strategic ("what should we build next") — chefs are good at narrow factual/technical questions, not roadmap calls.
- You're already mid-flow on a task and the question is a tangent — finish the current task first, then consult.

## How to use

1. Call `consult_list` to see which chefs exist. Cache the output mentally for the rest of the session.
2. Pick the right chef based on its `domain` description.
3. **Compose the question carefully.** The chef has zero context. Include:
   - The specific question, framed for someone who doesn't know your task.
   - Any error messages, file paths, or table names that are relevant.
   - The constraint or shape of the answer you need (one paragraph, a SQL query, a yes/no).
4. **Preview the question to the user before calling `consult`.** This is non-negotiable — same as outbound postman messages. The user is the gate.
5. Call `consult` with `chef`, `subject`, and `question`. The tool will block until the chef replies (default timeout 300s).
6. The reply lands in your context as the tool result. Use it. Don't second-guess it unless you have a specific reason to.

## Anti-patterns

- **Pinging chefs for things you can answer yourself.** Chefs cost real time (and tokens, in the chef's session). Ask only when the chef adds genuine expertise.
- **Pasting your full task context into the question.** The chef doesn't need it. State the question, give the relevant artifacts, ask.
- **Copying the chef's reply into a follow-up question to the same chef.** Use the same thread instead by replying to the chef's reply (they'll have the prior context).

## Example

User: "Find the BigQuery table that tracks checkout abandonment events and tell me how to query it for the last 7 days."

You: (preview the consult)

> I'm going to consult `chef-data` with this question:
>
> **Subject**: checkout abandonment table for last-7-days query
> **Question**: I need to query checkout abandonment events for the last 7 days. (1) What's the canonical BigQuery table for these events? (2) What's the partition column and time-zone convention? (3) Give me a working SQL example for "count of abandonments per day, last 7 days."
>
> Approve to send?

User: "yes"

You: (call `consult`)

Chef replies with the table name, partition info, and a working query. You return that to the user, possibly with a one-line note on what you did.
