---
name: add-mimo-v2-tts
description: Replace Gemini TTS with Xiaomi MiMo v2 TTS. Uses the OpenAI-compatible chat completions API with audio output. Converts text to voice messages and sends them via Feishu.
---

# Add MiMo v2 TTS

Adds text-to-speech capability to NanoClaw using Xiaomi MiMo v2 TTS. TTS runs server-side — the agent just sends text via the `send_tts_message` MCP tool, and the server generates audio and delivers it.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `mimo-v2-tts` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect information:

AskUserQuestion: Do you have a Xiaomi MiMo API key for text-to-speech?

If yes, collect it now. If no, direct them to create one at https://platform.xiaomimimo.com/.

### Requirements

- Feishu channel must be set up first (run `/add-feishu` if not)
- MiMo API key from https://platform.xiaomimimo.com/
- `ffmpeg` installed on the server host (`sudo apt install ffmpeg`)

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-mimo-v2-tts
```

This deterministically:
- Adds `src/tts.ts` (server-side TTS module using MiMo v2 API + ffmpeg)
- Three-way merges `sendAudio` into `src/types.ts` (Channel interface)
- Three-way merges `tts_message` handler into `src/ipc.ts`
- Three-way merges `sendAudio` mock into `src/ipc-auth.test.ts`
- Three-way merges `routeOutboundAudio` into `src/router.ts`
- Three-way merges `sendAudio` wiring into `src/index.ts`
- Three-way merges `send_tts_message` tool into `container/agent-runner/src/ipc-mcp-stdio.ts`
- Updates `.env.example` with `MIMO_API_KEY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/types.ts.intent.md` — what changed for types.ts
- `modify/src/ipc.ts.intent.md` — what changed for ipc.ts
- `modify/src/ipc-auth.test.ts.intent.md` — what changed for ipc-auth.test.ts
- `modify/src/router.ts.intent.md` — what changed for router.ts
- `modify/src/index.ts.intent.md` — what changed for index.ts
- `modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md` — what changed for MCP tool

### Manual steps after apply

The skills engine handles code changes, but these must be done manually:

1. **Feishu channel**: Ensure `sendAudio()` is implemented in `src/channels/feishu.ts` (done by `/add-feishu` skill)
2. **CLAUDE.md files**: Add TTS instructions to `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md`:

```markdown
## Voice Messages (TTS)

When the user asks for voice output ("read this as voice", "send as voice message", "TTS"):

1. Format text for speech (no markdown, natural sentences, spell out abbreviations)
2. Call: `mcp__nanoclaw__send_tts_message(text: "speech text", voice: "mimo_default")`

Available voices: mimo_default (default), default_zh (Chinese female), default_en (English female)

**Important**: Only format text for speech when generating TTS audio. Regular text messages should keep normal markdown formatting.
```

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

### Get MiMo API key (if needed)

If the user doesn't have an API key:

> I need a Xiaomi MiMo API key:
>
> 1. Go to https://platform.xiaomimimo.com/
> 2. Sign up and create an API key
> 3. Copy the key

Wait for the user to provide the key.

### Add to environment

Add to `.env`:

```bash
MIMO_API_KEY=<their-key>
```

### Install ffmpeg on server

```bash
sudo apt install ffmpeg
```

### Build and restart

```bash
npm run build
./container/build.sh       # Rebuild container (for updated MCP tool)
# Linux:
systemctl --user restart nanoclaw
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Test TTS

Send a message in a registered Feishu chat:

> @Wange TTS: Hello, this is a test of the text to speech system.

The agent should:
1. Call `send_tts_message` with speech-friendly text
2. Server generates audio via MiMo v2 TTS
3. Voice message appears in the chat

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i 'audio\|tts'
```

Look for:
- `IPC TTS message sent` — successful voice message delivery
- `MIMO_API_KEY not configured` — key not set in `.env`
- `MiMo TTS API error` — API key or quota issue

## Troubleshooting

### No voice message sent

1. Check `MIMO_API_KEY` is set in `.env`
2. Check `ffmpeg` is installed on the server: `which ffmpeg`
3. Verify Feishu bot has file upload permissions in the Feishu admin console

### Voice message fails to upload

Feishu requires the bot to have the `im:file` permission scope. Check the bot's permissions in the Feishu developer console.

### MiMo API errors

- **400 "messages must contain an assistant role"**: The text to synthesize must be in an `assistant` role message. This is handled by `src/tts.ts`.
- **400 "Unknown voice"**: Invalid voice name. Valid voices: `mimo_default`, `default_zh`, `default_en`. Invalid voices auto-fallback to `mimo_default`.

### Audio quality issues

Try different voices: `mimo_default` (default), `default_zh` (Chinese female), `default_en` (English female).
