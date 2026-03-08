# Intent: src/index.ts modifications

## What changed
Wired `sendAudio` into the IPC watcher deps, using `routeOutboundAudio` from the router.

## Key sections

### Imports
- Added: `routeOutboundAudio` to the router import

### startIpcWatcher call (inside main)
- Added: `sendAudio: (jid, audioPath) => routeOutboundAudio(channels, jid, audioPath)` to the IPC deps object

## Invariants (must-keep)
- All existing functionality unchanged (message loop, scheduler, channel setup, shutdown, recovery)
- All existing IPC deps (sendMessage, registeredGroups, registerGroup, syncGroups, getAvailableGroups, writeGroupsSnapshot) unchanged
- Channel opts callbacks unchanged
