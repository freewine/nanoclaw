# /clear Command

Already implemented. When a user sends `/clear` in any chat, the agent's conversation session is reset. The next message starts a fresh Claude session with no prior context.

## How It Works

1. `processGroupMessages()` in `src/index.ts` intercepts `/clear` before spawning a container
2. Deletes the session ID from memory (`sessions`) and DB (`deleteSession()` in `src/db.ts`)
3. Advances the message cursor so `/clear` itself isn't re-processed
4. Sends "Context cleared." confirmation to the user

## Files Changed

- `src/db.ts` — added `deleteSession(groupFolder)` function
- `src/index.ts` — imported `deleteSession`, added `/clear` intercept in `processGroupMessages()`
