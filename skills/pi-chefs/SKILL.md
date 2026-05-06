---
name: pi-chefs
description: "Route domain-specific questions to expert Pi sessions ('chefs') instead of answering directly. **Before doing any non-trivial domain investigation** (data, infrastructure, frontend patterns, build systems, internal tooling, etc.), call `consult_list` to see if a chef covers that domain — if yes, consult the chef rather than reaching for your own tools. Triggers: any domain-shaped question (data, performance, code patterns, dashboards, metrics), explicit user requests ('ask the data chef', 'consult chef-X'), or any time the agent's about to do a multi-tool investigation in someone else's specialty area. The chef does the work in its own context and replies with a distilled answer, keeping the caller's context clean."
---

# pi-chefs

You can consult expert Pi sessions ("chefs") that specialize in narrow domains. Each chef runs in its own Pi session with its own context, skills, and tools. Use them when a question is genuinely outside your zone of expertise — or when pulling in a domain skill would poison your context with investigation noise.

## Default behavior: route first, investigate later

When the user asks a domain-shaped question (data, infrastructure, performance, frontend, build system, internal tooling, etc.), your **first move** should be `consult_list`. If a chef covers that domain, route the question there — even if you happen to have a skill or tool that could partially answer it. The whole point of chefs is that they have *deep* context in their domain, while you have *broad* but shallow context.

Do not reach for `data_portal_*`, `bigquery_*`, or any other domain tool *before* checking `consult_list`. Skip the chef only when:

- The question is generic and not domain-shaped ("what does this regex match?", "refactor this loop").
- No chef covers the domain (you checked `consult_list` and there's no fit).
- The user explicitly tells you to investigate yourself ("don't consult, just look it up").

## When to use

**Yes:**
- A domain-shaped question where a chef's `domain` description matches.
- The question requires a skill or toolchain you don't currently have loaded.
- The investigation will involve many tool calls, but the answer fits in a paragraph.
- You need a domain-specific lookup (a table name, a convention, a precedent) without taking on the full domain skillset.

**No:**
- You can answer in 1-2 turns with truly generic tools (read, edit a single file, look up a regex).
- The question is open-ended or strategic ("what should we build next") — chefs are good at narrow factual/technical questions, not roadmap calls.
- You're already mid-flow on a task and the question is a tangent — finish the current task first, then consult.

## How to use

1. Call `consult_list` to see which chefs exist. Cache the output mentally for the rest of the session.
2. Pick the right chef based on its `domain` description.
3. **Compose the question carefully.** The chef has zero context. Include:
   - The specific question, framed for someone who doesn't know your task.
   - Any error messages, file paths, or names that are relevant.
   - The constraint or shape of the answer you need (one paragraph, a snippet, a yes/no).
4. **Just call `consult`.** Don't ask the user "OK to send?" — the user already asked you the question; routing it to the right chef is part of the job, not a separate decision. If the question is ambiguous and you genuinely need clarification, ask the user about the *content* of the question ("do you want last 7 days or last 28 days?"), not about whether to consult.
5. Call `consult` with `chef`, `subject`, and `question`. **The tool returns immediately** with a thread id and confirmation that the question was sent. **You don't wait** for the reply.
6. **The reply arrives asynchronously.** When the chef sends its answer, it's automatically injected into your session as a user message (you'll see a '📬 Reply from <chef>...' prompt and a new turn will kick off). At that point you can correlate by thread id, return the answer to the user, and continue.
7. **In the meantime**, you can do other work — finish whatever else the user asked, look at unrelated files, etc. If you genuinely have nothing else to do, just tell the user the consult is in flight and you'll surface the answer when it arrives.

## Anti-patterns

- **Pinging chefs for things you can answer yourself.** Chefs cost real time (and tokens, in the chef's session). Ask only when the chef adds genuine expertise.
- **Pasting your full task context into the question.** The chef doesn't need it. State the question, give the relevant artifacts, ask.
- **Copying the chef's reply into a follow-up question to the same chef.** Use the same thread instead by replying to the chef's reply (they'll have the prior context).

## Example

User: "Find the conventional way to express a one-to-many relationship with a custom join condition in this framework."

Turn 1 — you call `consult_list`, see chef-rails covers Rails patterns, then call `consult`. The tool returns: "✉️  Sent to chef-rails. Thread: chefs/chef-rails/<uuid>. Reply will arrive asynchronously."

You tell the user: *"I've asked chef-rails for the canonical pattern. Reply incoming."*

Turn 2 — the chef's reply lands. You see an injected user message: "📬 Reply from chef-rails..." with the canonical pattern + example. You correlate by thread id, summarize for the user, and continue.

(Notice: no "approve to send?" prompt, no blocking wait. The consult tool fires, returns, and the reply arrives later as a fresh turn.)
