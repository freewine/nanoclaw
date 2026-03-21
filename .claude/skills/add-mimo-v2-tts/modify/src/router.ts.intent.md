# Intent: src/router.ts modifications

## What changed
Added `routeOutboundAudio` function that routes audio messages to the appropriate channel, similar to `routeOutbound` for text.

## Key sections

### New function
- Added: `routeOutboundAudio(channels, jid, audioPath)` — finds the channel owning the JID, verifies it has `sendAudio`, and calls it. Throws if no audio-capable channel found.

## Invariants (must-keep)
- All existing functions (escapeXml, formatMessages, stripInternalTags, formatOutbound, routeOutbound, findChannel) unchanged
- Import list unchanged (only uses existing Channel, NewMessage from types)
