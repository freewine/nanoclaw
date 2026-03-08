# Intent: src/types.ts modifications

## What changed
Added optional `sendAudio` method to the Channel interface for channels that support voice/audio message delivery.

## Key sections

### Channel interface
- Added: `sendAudio?(jid: string, audioPath: string): Promise<void>;` — optional method for sending audio files

## Invariants (must-keep)
- All existing interfaces (AdditionalMount, MountAllowlist, AllowedRoot, ContainerConfig, RegisteredGroup, NewMessage, ScheduledTask, TaskRunLog) unchanged
- All existing Channel methods (connect, sendMessage, isConnected, ownsJid, disconnect, setTyping, syncGroups) unchanged
- OnInboundMessage and OnChatMetadata type aliases unchanged
