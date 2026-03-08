# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed
Added `send_tts_message` MCP tool that sends text to the server for TTS generation. The server handles audio generation — the agent just provides text and optional voice name.

## Key sections

### New tool (after register_group tool)
- Added: `send_tts_message` tool with `text` and optional `voice` parameters
  - Writes IPC file with type `tts_message`, chatJid, text, voice, groupFolder, timestamp
  - Tool description includes speech formatting tips and available voices
  - Writes to MESSAGES_DIR (not TASKS_DIR)

## Invariants (must-keep)
- All existing tools unchanged (send_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, update_task, register_group)
- writeIpcFile helper unchanged
- Environment variable setup (chatJid, groupFolder, isMain) unchanged
- Server/transport setup unchanged
