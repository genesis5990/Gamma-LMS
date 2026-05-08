# Deconflict (mygenesis-training)

**Deconflict** — Crypto Intelligence Sharing for investigators and agencies. Production site for **mygenesis-training.com**.

The Fly app slot (`mygenesis-training`) and domain remain on the original
identifiers; only the user-facing brand is Deconflict.

## Stack

| Layer       | Choice                                                                 |
|-------------|------------------------------------------------------------------------|
| Frontend    | Single-page vanilla JS (`public/course.html`) — no build step          |
| Auth        | Supabase magic-link email                                              |
| Database    | Supabase Postgres (project: **PlainScorm** / `fyacdyarcfgngqetmaoc`)   |
| Hosting     | fly.io (`gdaa-training-courses`, region `ord`) — Express static server |
| Container   | `node:20-alpine`, listens on `:8080`                                   |

## Layout

```
public/
  course.html         — main app (auth-gated)
  course_data.json    — course content (lessons, pages, quizzes)
  config.js           — runtime config (Supabase URL + publishable key)
  auth.js             — auth + progress sync layer
  index.html          — redirect to course.html
server/
  server.js           — tiny Express static server + /health
supabase/
  migrations/         — SQL schema (already applied to PlainScorm)
Dockerfile, fly.toml, package.json
```

## Local development

```bash
npm install
npm start
# → http://localhost:8080
```

## Deploy to fly.io

You must run this yourself (the workspace doesn't have your fly auth):

```bash
# First time only — log in
fly auth login

# Deploy (uses fly.toml in this repo, recycling the existing app slot)
fly deploy

# Attach the domain (one-time)
fly certs add www.mygenesis-training.com
fly certs add mygenesis-training.com
```

DNS at your registrar should point both records to fly:
- `A    @    66.241.124.x`     (use whatever IP `fly ips list` shows)
- `AAAA @    2a09:8280:1::x`
- `CNAME www mygenesis-training.com.`

(Or just `CNAME @ <app>.fly.dev` if your registrar supports apex CNAME.)

## Database

Schema lives in `supabase/migrations/0001_phase1_init.sql`.

It has already been applied to the **PlainScorm** project in your Supabase
account. To re-apply (e.g. on a fresh project):

```bash
psql "postgresql://postgres:<password>@db.fyacdyarcfgngqetmaoc.supabase.co:5432/postgres" \
  -f supabase/migrations/0001_phase1_init.sql
```

## Auth configuration in Supabase

In the PlainScorm project's Auth settings:

1. **Email auth** — enable, disable password (magic link only).
2. **URL configuration** — set Site URL to `https://www.mygenesis-training.com`,
   add `http://localhost:8080` to Redirect URLs for local dev.
3. **Email templates** — customize the magic-link email subject/body.
4. **SMTP (recommended)** — wire up Resend/Postmark so emails come from
   `noreply@mygenesis-training.com` instead of the default Supabase sender.

## Roadmap

- **Phase 1** (this build) — accounts + cloud-synced progress + cert stub
- **Phase 2** — server-generated PDF certificates with public verification
- **Phase 3** — department accounts, seats, billing, admin dashboards
