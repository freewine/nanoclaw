# Intent: src/ipc.ts modifications

## What changed
Added server-side TTS support. When a `tts_message` IPC file arrives, the server generates speech audio via Gemini TTS and sends it as an audio message.

## Key sections

### Imports (top of file)
- Added: `import { generateSpeech } from './tts.js';`

### IpcDeps interface
- Added: `sendAudio: (jid: string, audioPath: string) => Promise<void>;`

### Message processing (inside processIpcFiles)
- Added: `tts_message` handler after existing `message` handler
  - Same authorization pattern (isMain or same-group check)
  - Calls `generateSpeech(data.text, data.voice)` to generate opus file
  - Calls `deps.sendAudio(data.chatJid, audioPath)` to send it
  - Cleans up temp file in `finally` block

## Invariants (must-keep)
- Existing `message` type handler unchanged
- Task processing (processTaskIpc) unchanged
- All task IPC types (schedule_task, pause_task, resume_task, cancel_task, update_task, refresh_groups, register_group) unchanged
- IPC file polling, error handling, and directory structure unchanged
- Authorization pattern (isMain or folder match) unchanged
