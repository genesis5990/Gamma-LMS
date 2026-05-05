-- =====================================================================
-- Crypto 101 / mygenesis-training.com — Phase 1 schema
-- Project: PlainScorm (fyacdyarcfgngqetmaoc)
-- =====================================================================

-- DEPARTMENTS (Phase-3 placeholder so the FK below resolves)
create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- PROFILES — extends auth.users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  badge_number text,
  agency_name text,
  role text not null default 'student' check (role in ('student','dept_admin','super_admin')),
  department_id uuid references public.departments(id),
  created_at timestamptz not null default now()
);

-- ENROLLMENTS — one row per user per course
create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id text not null default 'crypto101',
  status text not null default 'active' check (status in ('active','completed','withdrawn')),
  enrolled_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, course_id)
);

-- LESSON PROGRESS — one row per user per lesson
create table if not exists public.lesson_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  lesson_id text not null,
  viewed_pages int[] not null default '{}',
  complete boolean not null default false,
  last_viewed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

-- QUIZ ATTEMPTS — append-only audit trail
create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  lesson_id text not null,
  attempt_no int not null,
  score int not null check (score between 0 and 100),
  passed boolean not null,
  answers jsonb not null,
  submitted_at timestamptz not null default now()
);
create index if not exists quiz_attempts_user_lesson_idx
  on public.quiz_attempts (user_id, lesson_id, attempt_no desc);

-- CERTIFICATES — Phase-1 stub row, Phase-2 fills pdf_url
create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id text not null default 'crypto101',
  final_score int,
  pdf_url text,
  issued_at timestamptz not null default now(),
  revoked boolean not null default false,
  unique (user_id, course_id)
);

-- =====================================================================
-- AUTO-CREATE PROFILE + ENROLLMENT ON SIGNUP
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  insert into public.enrollments (user_id, course_id)
  values (new.id, 'crypto101')
  on conflict (user_id, course_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.profiles        enable row level security;
alter table public.enrollments     enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.quiz_attempts   enable row level security;
alter table public.certificates    enable row level security;
alter table public.departments     enable row level security;

-- profiles
drop policy if exists "self read"   on public.profiles;
drop policy if exists "self update" on public.profiles;
create policy "self read"   on public.profiles for select using (auth.uid() = id);
create policy "self update" on public.profiles for update using (auth.uid() = id);

-- enrollments
drop policy if exists "self read" on public.enrollments;
create policy "self read" on public.enrollments for select using (auth.uid() = user_id);

-- lesson_progress
drop policy if exists "self read"   on public.lesson_progress;
drop policy if exists "self insert" on public.lesson_progress;
drop policy if exists "self update" on public.lesson_progress;
create policy "self read"   on public.lesson_progress for select using (auth.uid() = user_id);
create policy "self insert" on public.lesson_progress for insert with check (auth.uid() = user_id);
create policy "self update" on public.lesson_progress for update using (auth.uid() = user_id);

-- quiz_attempts (append-only — no update/delete policies)
drop policy if exists "self read"   on public.quiz_attempts;
drop policy if exists "self insert" on public.quiz_attempts;
create policy "self read"   on public.quiz_attempts for select using (auth.uid() = user_id);
create policy "self insert" on public.quiz_attempts for insert with check (auth.uid() = user_id);

-- certificates (server-role writes only; users can read their own)
drop policy if exists "self read" on public.certificates;
create policy "self read" on public.certificates for select using (auth.uid() = user_id);

-- departments (Phase-3; admins only — leave restrictive for now, no policies = no access)
