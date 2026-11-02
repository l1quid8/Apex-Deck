# Assistant settings inventory

Where every assistant setting lives after the Alfred upgrade. All save through the existing versioned workspace configuration under the unchanged assistant id, unless the row says otherwise.

| Setting | Home | Scope and notes |
| --- | --- | --- |
| Name, avatar, color | General | This assistant. |
| Provider, model, reasoning | Model | Assistant-owned snapshot. |
| Project tools, per-project access, folder grants | Projects & access | Folder grants save at once. |
| Browser and take over | Projects & access | The existing assistant browser and profile. |
| Unified Computer Use status | Capabilities | Explained only. Enabling, permissions, cursor and labels stay in Settings → Unified Computer Use. App access is granted per conversation. |
| Floating window | Capabilities, ⋯ menu | Keep on top is set inside the window and remembered with its place. |
| Reply style, timezone, quiet hours | Preferences | |
| Daily limit, unknown costs, local only, endpoints, context budget | Costs & privacy | Cost history opens from here. |
| Call engine, GPT-Live model and voice, local voice, pause, call controls | Voice | App-wide defaults. Nicknames stay in call settings. |
| Personal notes, project notebooks | Memory | New conversation leaves these alone. |
| Connections, action modes, standing rules, schedules, notices | Tools & rules | Each saves through its own action. |
| Remove and restore | Remove assistant | History, notes and projects are kept. |

## Known limits

- Model image support is shown, not set, for assistants: an API model's "can read images" comes from its saved agent profile.
- Provider session reset and compaction don't exist for assistants. New conversation only moves where the model's context starts.
- The floating window has no attachments or approval cards; both stay in Deck. Its Call button uses the same call Deck would start.
