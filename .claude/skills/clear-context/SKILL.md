# Clear Context Skill

Resets the agent's conversation context for a group chat.

## Usage

Send `/clear` or `/reset` in any registered group chat. The bot replies "Context cleared." and the next message starts a fresh agent session.

## How It Works

- Exact match only — `/clearall`, `please /clear`, etc. do not trigger it
- Deletes the in-memory and persisted session for the group
- Advances the message cursor so cleared messages aren't reprocessed
- Terminates any running container so the next message spawns a fresh one
- Works in both the main group (no trigger prefix needed) and non-main groups (bypasses trigger check)

## Files Changed

| File | Change |
|------|--------|
| `src/db.ts` | Added `deleteSession()` to remove session from SQLite |
| `src/index.ts` | Added `CLEAR_COMMAND_PATTERN` constant and interception in `processGroupMessages()` and `startMessageLoop()` |
