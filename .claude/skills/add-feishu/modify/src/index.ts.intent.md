# Intent: src/index.ts modifications

## What changed
Added Feishu channel support alongside the existing WhatsApp channel using the multi-channel architecture.

## Key sections

### Imports (top of file)
- Added: `FeishuChannel` from `./channels/feishu.js`
- Added: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN`, `FEISHU_ONLY` from `./config.js`

### Module-level state
- Added: `let feishu: FeishuChannel | undefined` — reference needed for `syncChatMetadata`
- Kept: `let whatsapp: WhatsAppChannel` — still needed for `syncGroupMetadata` reference
- Kept: `const channels: Channel[] = []` — array of all active channels

### main()
- Added: conditional Feishu creation (`if (FEISHU_APP_ID)`) — creates and connects FeishuChannel
- Added: conditional WhatsApp skip (`if (!FEISHU_ONLY)`) — when true, only Feishu runs
- Changed: `syncGroupMetadata` in IPC watcher now also calls `feishu.syncChatMetadata()`

### processGroupMessages()
- Unchanged: already uses `findChannel(channels, chatJid)` which routes to correct channel

### startMessageLoop()
- Unchanged: already uses `findChannel(channels, chatJid)` for channel-agnostic routing

### getAvailableGroups()
- Unchanged: uses `c.is_group` filter from database (Feishu channels pass `isGroup=true` via `onChatMetadata`)

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic (in WhatsAppChannel, not here)
