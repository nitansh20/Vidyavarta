# Security Policy

VidyaVarta is designed as a local-first application. Its live bridge binds to loopback and is not intended to be exposed to the public internet. Use test accounts and consenting recipients for demonstrations.

## Reporting a vulnerability

Do not publish credentials, tokens, student records, or a detailed exploit in a public issue. If this repository enables GitHub private vulnerability reporting, use that feature; otherwise contact the project maintainers privately through the repository owner.

## Secrets and local data

Keep `.env`, `.campus-live/`, OAuth credentials, SMTP passwords, and real student data out of Git. The example file `.env.example` contains placeholders and may be committed.
