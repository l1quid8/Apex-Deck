# How Claude and Codex ask the person a question

Probed 2026-10-06 with Claude Code 2.1.292 and codex-cli 0.160.0, in a scratch folder.

## Claude, ask-first

Started as Deck starts it (`-p --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --permission-mode default`). Asked to use AskUserQuestion for two questions, one multi-select.

```
REQUEST: {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "display_name": "AskUserQuestion", "input": {"questions": [{"question": "Which colour do you like?", "header": "Colour", "options": [{"label": "Red", "description": "The colour red"}, {"label": "Blue", "description": "The colour blue"}], "multiSelect": false}, {"question": "Which fruits do you like?", "header": "Fruits", "options": [{"label": "Apple", "description": "Apples"}, {"label": "Pear", "description": "Pears"}], "multiSelect": true}]}, "tool_use_id": "toolu_01E3fGDi6T94hFYLfoyJPZC5", "requires_user_interaction": true}
RESPONSE: {"type": "control_response", "response": {"subtype": "success", "request_id": "8fd2dd13-77f5-4bcf-8ff1-bf78e2351139", "response": {"behavior": "allow", "updatedInput": {"questions": [{"question": "Which colour do you like?", "header": "Colour", "options": [{"label": "Red", "description": "The colour red"}, {"label": "Blue", "description": "The colour blue"}], "multiSelect": false}, {"question": "Which fruits do you like?", "header": "Fruits", "options": [{"label": "Apple", "description": "Apples"}, {"label": "Pear", "description": "Pears"}], "multiSelect": true}], "answers": {"Which colour do you like?": "blue", "Which fruits do you like?": "apple, pear"}}}}}
TOOL_RESULT: {"type": "tool_result", "content": "The user answered: \"Which colour do you like?\"=\"blue\", \"Which fruits do you like?\"=\"apple, pear\". Read the answers carefully \u2014 they may request clarification, changes, or that you not proceed \u2014 and follow what they actually say.", "tool_use_id": "toolu_01E3fGDi6T94hFYLfoyJPZC5"}
RESULT: You like blue, and both apples and pears.
```

The request carries `"requires_user_interaction": true`. Allowing it with `updatedInput` = the input plus `answers` (keyed by each question's text, several picks joined with ", ") gives Claude the answers.

## Claude, Full access

Same, with `--permission-mode bypassPermissions`. Claude still sends AskUserQuestion through `can_use_tool` and the same answer works:

```
RESULT: You like blue, and you like both apples and pears.
```

So Full-access Claude bots can ask too.

## Codex schema

From `codex app-server generate-json-schema` (marked EXPERIMENTAL):

- Method: `item/tool/requestUserInput` (server request).
- Params: `{threadId, turnId, itemId, isBlocking, autoResolutionMs?, questions: [{id, header, question, isOther, isSecret, options: [{label, description}] | null}]}`.
- Result: `{answers: {<question id>: {answers: [string]}}}`.

## Codex in a normal turn

Driven like Deck drives it (`experimentalApi` on, `thread/start` ephemeral, read-only, `on-request`), and asked to use its request_user_input tool. Codex sent **no** server request; it wrote the questions as plain text in its reply:

```
AGENT: Which colour do you like?
- Red
- Blue

Which fruit do you like?
- Apple
- Pear
```

Codex does not ask in a normal turn on 0.160.0. The tool is probably limited to its plan collaboration mode (not tested), which Deck does not use. Codex mid-task questions are left out for now.
