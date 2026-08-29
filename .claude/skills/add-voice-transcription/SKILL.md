---
name: add-voice-transcription
description: Enable voice message transcription for Deus's WhatsApp channel using OpenAI's transcription API (gpt-4o-transcribe / whisper-1). Automatically transcribes WhatsApp voice notes and audio attachments so the agent can read and respond to them.
disable-model-invocation: true
---

# Add Voice Transcription

This skill enables automatic voice message transcription for Deus's WhatsApp channel using OpenAI's transcription API. When a voice note (or an `audio/*` attachment) arrives in a registered chat, the channel downloads it, the host transcribes it, and the agent receives `[Voice: <transcript>]` (or `[Audio "<file>": <transcript>]`).

## Phase 1: Pre-flight

### Check if already applied

Check if `src/openai-transcription.ts` exists. If it does, skip to Phase 3 (Configure). The code changes are already in place. (`src/transcription.ts` is a different module — local whisper.cpp for the `deus listen` CLI.)

### Ask the user

Use `AskUserQuestion` to collect information:

AskUserQuestion: Do you have an OpenAI API key for Whisper transcription?

If yes, collect it now. If no, direct them to create one at https://platform.openai.com/api-keys.

## Phase 2: Apply Code Changes

**Prerequisite:** WhatsApp must be installed first (via `/add-whatsapp`). This skill modifies WhatsApp channel files.

Voice transcription is split between the WhatsApp MCP package (download only, no credentials) and the host (transcription). Check that both halves exist:

```bash
test -f src/openai-transcription.ts && test -f packages/mcp-whatsapp/src/audio.ts && echo "Already present" || echo "Not present"
```

If not present, update the repo — the code ships on `main`; no per-install code changes are needed.

The following files are involved:

- `packages/mcp-whatsapp/src/audio.ts` — classifies voice notes / audio attachments, downloads to `$TMPDIR/deus-whatsapp-audio/`
- `packages/mcp-whatsapp/src/whatsapp.ts` — emits `[Voice Message]` + `metadata.audio` for the host
- `src/openai-transcription.ts` — host-side validation, OpenAI call via the `OpenAIAuthProvider`, per-chat hourly cap
- `src/index.ts` — transcribes only for registered chats whose sender may trigger the agent
- `OPENAI_API_KEY`, `DEUS_TRANSCRIPTION_MODEL`, `DEUS_TRANSCRIPTION_HOURLY_CAP` in `.env.example`

### Validate code changes

```bash
npm run build
npx vitest run src/openai-transcription.test.ts src/channels/mcp-adapter.test.ts
(cd packages/mcp-whatsapp && npx vitest run)
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

### Get OpenAI API key (if needed)

If the user doesn't have an API key:

> I need you to create an OpenAI API key:
>
> 1. Go to https://platform.openai.com/api-keys
> 2. Click "Create new secret key"
> 3. Give it a name (e.g., "Deus Transcription")
> 4. Copy the key (starts with `sk-`)
>
> Cost: ~$0.006 per minute of audio (~$0.003 per typical 30-second voice note)

Wait for the user to provide the key.

### Add to environment

Add to `.env`:

```bash
OPENAI_API_KEY=<their-key>
# optional: DEUS_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe   (default gpt-4o-transcribe)
# optional: DEUS_TRANSCRIPTION_HOURLY_CAP=30                  (per chat)
```

The key stays on the host: the host process reads it once at startup for the credential proxy and transcription. It never enters the WhatsApp channel process or any container, so rotating it requires a restart.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.deus  # macOS
# Linux: systemctl --user restart deus
```

## Phase 4: Verify

### Test with a voice note

Tell the user:

> Send a voice note in any registered WhatsApp chat. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs if needed

```bash
tail -f logs/deus.log | grep -i voice
```

Look for:

- `Transcribed voice message` — success (bytes, mimetype, character count; the transcript itself is never logged)
- `Voice transcription unavailable: OPENAI_API_KEY not configured` — key missing from `.env`
- `OpenAI rejected transcription credentials` — 401/403; the key was revoked or rotated → restart the service
- `Voice transcription failed` — other API/network error
- `Voice transcription rate limit reached` — per-chat hourly cap hit
- `Rejected audio reference from channel` — the host refused the temp-file reference (see reason)
- `Audio download failed` (in `logs/deus.error.log`, from the channel process) — media download issue

## Troubleshooting

### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `OPENAI_API_KEY` is set in `.env`, then restart the service (the key is read at startup)
2. Verify key works: `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 200`
3. Check OpenAI billing — the transcription endpoints require a funded account

### Voice notes show "[Voice Message - transcription failed]"

Check logs for the specific error. Common causes:

- Network timeout — transient, will work on next message
- Unsupported audio for the chosen model — try `DEUS_TRANSCRIPTION_MODEL=whisper-1`

### Voice notes show "[Voice Message]" with no transcript

The message was stored but not transcribed: the chat is not registered, the sender is not allowed to trigger the agent (sender allowlist), or the host rejected the temp-file reference. Check `logs/deus.log` for `Rejected audio reference`.

### Voice notes show "[Voice Message - too large to transcribe …]"

OpenAI accepts files up to 25 MB. Ask for a shorter recording or a compressed format.
