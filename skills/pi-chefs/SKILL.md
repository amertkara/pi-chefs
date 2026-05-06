# pi-chefs

You can consult expert Pi sessions ("chefs") that specialize in narrow domains. Each chef runs in its own Pi session with its own context, skills, and tools. Use them when a question is genuinely outside your zone of expertise — or when pulling in a domain skill would poison your context with investigation noise.

## When to use

**Yes:**
- The question requires a skill or toolchain you don't currently have loaded → consult the chef whose domain covers it.
- You need a domain-specific lookup (a table name, a convention, a precedent) without taking on the full domain skillset.
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
   - Any error messages, file paths, or names that are relevant.
   - The constraint or shape of the answer you need (one paragraph, a snippet, a yes/no).
4. **Preview the question to the user before calling `consult`.** This is non-negotiable — same as outbound postman messages. The user is the gate.
5. Call `consult` with `chef`, `subject`, and `question`. The tool will block until the chef replies (default timeout 300s).
6. The reply lands in your context as the tool result. Use it. Don't second-guess it unless you have a specific reason to.

## Anti-patterns

- **Pinging chefs for things you can answer yourself.** Chefs cost real time (and tokens, in the chef's session). Ask only when the chef adds genuine expertise.
- **Pasting your full task context into the question.** The chef doesn't need it. State the question, give the relevant artifacts, ask.
- **Copying the chef's reply into a follow-up question to the same chef.** Use the same thread instead by replying to the chef's reply (they'll have the prior context).

## Example

User: "Find the conventional way to express a one-to-many relationship with a custom join condition in this framework."

You: (preview the consult)

> I'm going to consult `chef-rails` with this question:
>
> **Subject**: one-to-many with custom join condition convention
> **Question**: I need to express a one-to-many relationship where the join condition isn't just a foreign key (e.g. only matching active records, or matching on a composite key). What's the idiomatic Rails/ActiveRecord pattern? A short example would help.
>
> Approve to send?

User: "yes"

You: (call `consult`)

Chef replies with the canonical pattern and a short example. You return that to the user with one line of context for the task.
