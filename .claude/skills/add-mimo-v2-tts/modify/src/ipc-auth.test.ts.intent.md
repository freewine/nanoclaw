# Intent: src/ipc-auth.test.ts modifications

## What changed
Added `sendAudio` mock to IpcDeps to satisfy the updated interface that includes audio support.

## Key sections

### IpcDeps mock (beforeEach)
- Added: `sendAudio: async () => {},` to the deps mock object

## Invariants (must-keep)
- All existing test suites unchanged (schedule_task, pause_task, resume_task, cancel_task, register_group, refresh_groups, IPC message authorization, schedule types, context_mode)
- All existing test assertions unchanged
- All existing mock setup unchanged
