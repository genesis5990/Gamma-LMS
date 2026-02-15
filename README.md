# Genesis Digital Assets Training Platform

A Next.js 14 LMS with Gamma presentation import, per-slide audio synchronization, and Stripe payments.

## Features

- **Gamma Import**: Import presentations directly from Gamma
- **Per-Slide Audio**: Upload and sync audio narration for each slide
- **Progress Tracking**: Auto-save progress as students learn
- **Stripe Payments**: Secure payment processing for paid courses
- **Supabase**: Database, auth, and storage

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your Supabase and Stripe credentials

# Run dev server
npm run dev
```

## Deployment

### 1. Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Run the migration in `database/migrations/001_initial_schema.sql`
3. Create storage buckets: `slides`, `course-audio`
4. Copy your project URL and anon key

### 2. Stripe Setup

1. Create account at [stripe.com](https://stripe.com)
2. Get your API keys from the Dashboard
3. Configure webhook endpoint to `/api/webhook/stripe`

### 3. Fly.io Setup

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login

# Create app
flyctl apps create gamma-lms

# Set secrets
flyctl secrets set STRIPE_SECRET_KEY=sk_live_...
flyctl secrets set STRIPE_WEBHOOK_SECRET=whsec_...
flyctl secrets set SUPABASE_SERVICE_ROLE_KEY=eyJhbG...
flyctl secrets set OPENAI_API_KEY=sk-...
flyctl secrets set NEXT_PUBLIC_SUPABASE_URL=https://...
flyctl secrets set NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...
flyctl secrets set NEXT_PUBLIC_SITE_URL=https://mygenesisdigitalassetstraining.com

# Deploy
flyctl deploy
```

### 4. GitHub Actions

Add `FLY_API_TOKEN` to your GitHub repository secrets.

## Project Structure

```
gamma-lms-platform/
├── app/
│   ├── api/              # API routes
│   ├── auth/             # Auth pages
│   ├── course/           # Course player
│   └── admin/            # Admin dashboard
├── components/           # React components
├── lib/                  # Utilities & clients
├── database/             # Migrations
└── types/                # TypeScript types
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret |
| `OPENAI_API_KEY` | OpenAI API key (for AI features) |
| `NEXT_PUBLIC_SITE_URL` | Production site URL |

## License

MIT
