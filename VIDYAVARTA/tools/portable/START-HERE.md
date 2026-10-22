# VidyaVarta - Ready Package (LIVE mode)

This folder is the zero-install Windows runtime of VidyaVarta. Since Version 1
it runs the SAME live product as the developer source: real sign-ins, your
real class directory, real email/Classroom delivery when configured.

## What you need before first start

1. A `.env` file next to `launcher.cjs` (or inside `data\`). Minimum:

```
CAMPUS_SECRET_KEY=<64 hex characters>
```

Generate one in Command Prompt:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

2. Optional but recommended on first start:

```
CAMPUS_ADMIN_PASSWORD=choose-a-strong-password
```

If you skip it, a strong random password is generated once, printed in the
launcher window, and saved to `data\admin-password.txt`.

3. Email and Google Classroom are optional. Add when you are ready:

```
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_ALLOWLIST
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=http://127.0.0.1:4318/oauth/callback
OLLAMA_HOST, OLLAMA_MODEL   (local AI drafts, optional)
```

## Start

Double-click `CHECK-SETUP.cmd` once (checks Node), then `launcher.cjs`
via the START shortcut, or run in Command Prompt:

```
"C:\Program Files\nodejs\node.exe" launcher.cjs
```

Open the printed address (usually http://127.0.0.1:5173/). Sign in as
`admin` with your initial password, then create your team accounts from
the app (Team accounts button).

## First live steps

1. Team accounts - create the faculty accounts (role: Faculty).
2. Student directory - Import students (CSV) with your real class list.
3. Integrations - connect Google Classroom per teacher (consenting test
   teachers only) and configure SMTP with a strict allowlist.
4. Circular watcher - press "Scan now" once per source to record the
   baseline; new/changed circulars then appear as notice drafts.

## Notes

- The bridge binds to 127.0.0.1 only. Nothing is reachable from other
  devices unless you explicitly change CAMPUS_PREVIEW (not recommended).
- Every sign-in, approval, post and send is written to the audit chain.
- Public website scans need internet. Everything else works offline.
