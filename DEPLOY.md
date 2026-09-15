# Telegram + Render deployment

1. Create a **new private GitHub repository** for this bot. Do not use the existing `afriproxy` remote.
2. Add this project to that repository. Do not commit `.env` or `data/`.
3. Create a Telegram bot with BotFather and record its token. Send `/start` to the bot, then obtain your numeric chat ID (for example using `getUpdates`).
4. In Render, create a Blueprint from the repository. Set the secret environment variables:
   - `PRIVATE_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. After deployment, set a GitHub Actions secret named `RENDER_HEALTH_URL` to the Render service URL, without a trailing slash. The scheduled workflow pings `/health` every 10 minutes.

Telegram commands (restricted to `TELEGRAM_CHAT_ID`):

- `/status` — balances, totals, and bot state
- `/pause` or `/stop` — pause after any in-flight transaction
- `/start` or `/resume` — resume cycles
- `/help` — command list

The service exposes `/health` for Render and the keep-alive workflow. It never returns the private key.