# Intent: src/config.ts modifications

## What changed
Added four new configuration exports for Feishu channel support.

## Key sections
- **readEnvFile call**: Must include `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ONLY`, and `FEISHU_DOMAIN` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **FEISHU_APP_ID**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty)
- **FEISHU_APP_SECRET**: Read from `process.env` first, then `envConfig` fallback, defaults to empty string
- **FEISHU_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation
- **FEISHU_DOMAIN**: Domain selector — `'feishu'` (China, default) or `'lark'` (international)

## Invariants
- All existing config exports remain unchanged
- New Feishu keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Feishu config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
