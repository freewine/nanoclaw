---
name: add-feishu
description: Add Feishu (飞书) as a channel. Can replace WhatsApp entirely or run alongside it. Uses WebSocket connection — no public URL needed.
---

# Add Feishu Channel

This skill adds Feishu (飞书) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should Feishu replace WhatsApp or run alongside it?
- **Replace WhatsApp** - Feishu will be the only channel (sets FEISHU_ONLY=true)
- **Alongside** - Both Feishu and WhatsApp channels active

AskUserQuestion: Which Feishu domain do you use?
- **Feishu (飞书)** - China mainland (feishu.cn) — default
- **Lark** - International (larksuite.com)

AskUserQuestion: Do you have a Feishu app ID and secret, or do you need to create one?

If they have credentials, collect them now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:
- Adds `src/channels/feishu.ts` (FeishuChannel class implementing Channel interface)
- Adds `src/channels/feishu.test.ts` (40+ unit tests)
- Three-way merges Feishu support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Feishu config into `src/config.ts` (FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_ONLY, FEISHU_DOMAIN exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY`, and `FEISHU_DOMAIN`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new feishu tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have app credentials, tell them:

> I need you to create a Feishu custom app:
>
> 1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark Developer](https://open.larksuite.com/app) for international)
> 2. Click **Create Custom App**
>    - App name: Something friendly (e.g., "Andy Assistant")
>    - Description: Your NanoClaw assistant
> 3. In the app page, go to **Credentials & Basic Info** and copy:
>    - **App ID** (looks like `cli_abc123def456`)
>    - **App Secret** (looks like `abcdefghijklmnopqrstuvwxyz123456`)
> 4. Go to **Add Features** > **Bot** and enable the bot capability
> 5. Go to **Permissions & Scopes** and add these scopes:
>    - `im:message` (Send and receive messages)
>    - `im:message.group_at_msg` (Receive @mention messages in groups)
>    - `im:chat:readonly` (Read chat list — for group discovery)
>    - `contact:user.base:readonly` (Read user names — for sender display)
> 6. Go to **Event Subscriptions** and enable **Use long connection (WebSocket)**
>    - Add event: `im.message.receive_v1` (Message received)
> 7. Go to **Version Management & Release** > Click **Create Version** > **Submit for review**
>    - For internal company apps, approval is usually instant

Wait for the user to provide the App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<their-app-id>
FEISHU_APP_SECRET=<their-app-secret>
```

If they chose to replace WhatsApp:

```bash
FEISHU_ONLY=true
```

If they use Lark (international):

```bash
FEISHU_DOMAIN=lark
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
```

For macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

For Linux:
```bash
systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open Feishu and find the group/chat where you want the bot
> 2. Add the bot to the group (search for it by its app name)
> 3. Send any message in the group — the bot's logs will show the chat ID
> 4. Check logs: `tail -f logs/nanoclaw.log | grep "unregistered Feishu"`
>
> The chat ID will look like: `feishu:oc_abc123def456`

Wait for the user to provide the chat ID.

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Feishu chat:
> - For main chat: Any message works
> - For non-main: @mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"`
3. For non-main chats: message includes @mention of the bot
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. App is published and approved in Feishu Open Platform

### Bot can't receive messages

1. Verify the app has **Bot** capability enabled
2. Check that **Event Subscriptions** uses WebSocket mode (not HTTP callback)
3. Verify `im.message.receive_v1` event is subscribed
4. Make sure the app has been published (draft apps can't receive events)

### Permission errors

1. Ensure all required scopes are added: `im:message`, `im:message.group_at_msg`, `im:chat:readonly`, `contact:user.base:readonly`
2. Re-publish the app after adding new scopes
3. For `contact:user.base:readonly`: some orgs require admin approval

### Feishu vs Lark

- **Feishu** (飞书): China mainland — domain `feishu.cn`, set `FEISHU_DOMAIN=feishu` (default)
- **Lark**: International — domain `larksuite.com`, set `FEISHU_DOMAIN=lark`
- You cannot mix — use the domain that matches your organization

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `FeishuChannel` import and creation from `src/index.ts`
3. Remove `feishu` variable and revert `syncGroupMetadata` to WhatsApp-only
4. Remove Feishu config (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY`, `FEISHU_DOMAIN`) from `src/config.ts`
5. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"`
6. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
