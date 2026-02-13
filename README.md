# MAGI

![MAGI](./docs/img/magi_rull.png?raw=true "MAGI")

NERV headquarters' decision-making supercomputer system, now accessible through your Telegram terminal.

Three personality-transplant cores deliberate on your query and render judgment — just as Dr. Akagi Naoko designed.

## Setup

```bash
cp .env.example .env
# Fill in GROQ_API_KEY and TELEGRAM_BOT_TOKEN
```

## Run

```bash
deno task start
```

## Commands

| Command | Description |
|---------|-------------|
| `/magi <query>` | Submit a query to the three cores |
| `/status` | System diagnostics |
| `/info` | MAGI system information |
| `/lang <language>` | Language settings (en/ja/ko or auto) |
| `/nerv` | Receive a transmission |
| `/help` | Command list |

## BotFather Configuration

Reference for `/setcommands` and other BotFather settings.

### /setcommands

```
magi - Submit a query to the MAGI cores
status - MAGI system diagnostics
info - MAGI system information
lang - Language settings (en/ja/ko or auto)
nerv - Receive a NERV transmission
help - Command list
```

### /setdescription

```
NERV headquarters' decision-making supercomputer system.
Three personality-transplant cores — MELCHIOR, BALTHASAR, and CASPER — deliberate on your query and render judgment by majority consensus.
```

### /setabouttext

```
MAGI System — Personality-transplant supercomputer triad by Dr. Akagi Naoko.
Use /magi <question> to deliberate.
```

## Structure

```
main.ts               Entry point, init, polling
src/
  bot.ts              Telegram bot (grammY)
  storage.ts          Deno KV persistent storage
  groq/
    client.ts         Groq API client
    ratelimits.ts     Rate limit tracking (RPD/TPM/RPM) with KV persistence
    personas.ts       Core personality configurations
  magi/
    engine.ts         Three-core deliberation orchestrator
    types.ts          Shared types
  image/
    renderer.ts       MAGI visualization renderer
  i18n/
    detector.ts       Language detection (en/ja/ko)
    messages.ts       Localized messages
    *.json            Message bundles
assets/
  fonts/              CJK monospace font
```
