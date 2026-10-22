# VidyaVarta — Campus Communication Platform

VidyaVarta is a local-first campus communication and classroom workflow application. It combines circular monitoring, directory import, approval-gated notice workflows, audit records, and optional local AI drafting. Email and Google Classroom integrations require authorized setup. The app is designed to run on the operator’s own computer and binds to loopback; this repository is not a public hosted service.

## Requirements

- Node.js 24 (recommended)
- npm
- Windows, macOS, or Linux

## Run locally

From the repository root (the folder containing `package.json`):

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3
```

Copy `.env.example` to `.env` in the repository root (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` in macOS/Linux). Set `CAMPUS_SECRET_KEY` using the command below, then start the app:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run dev:live
```

Paste the generated 64-character hex value into `CAMPUS_SECRET_KEY` in `.env`. The app loads `.env` from this repository root. Open the local URL printed in the terminal. The first run creates a local operator account; if `CAMPUS_ADMIN_PASSWORD` is not set, the one-time password is printed locally and stored in the ignored `.campus-live/` data directory.

## Configuration

- `CAMPUS_SECRET_KEY` is required for encrypted integration-token storage. Keep it private and back it up securely.
- `CAMPUS_ADMIN_PASSWORD` is optional; use a strong unique password if you set it.
- SMTP is optional. If enabled, use a provider app password and restrict `SMTP_ALLOWLIST` to consenting test recipients.
- Google Classroom is optional and requires an OAuth client, consent configuration, and the exact local redirect URI shown in `.env.example`.
- Ollama is optional; when used, install Ollama locally and select a model in `.env`.

Never commit `.env`, `.campus-live/`, credentials, OAuth secrets, refresh tokens, or real student data. `.gitignore` excludes local secrets and data. `.env.example` contains placeholders only.

## Checks

```bash
npm run typecheck
npm test
npm run build:web
```

The automated tests cover selected software behavior. They do not prove institutional adoption, educational impact, production readiness, or a live email/Classroom delivery.

## Safety

The live bridge is intentionally loopback-only and rejects public host exposure. Do not start it with `--host 0.0.0.0` or deploy it as a public site without a separate security redesign. Use test accounts and consenting recipients for demonstrations.
