-- QUANTERA · AI 요약 사용량 기록 (피터 써머리). Supabase SQL 편집기에 붙여 넣고 실행하세요. 여러 번 실행해도 안전해요.
create table if not exists public.q_ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  model text,
  market text,
  in_tokens int,
  out_tokens int,
  neurons numeric
);
create index if not exists q_ai_usage_user_at on public.q_ai_usage (user_id, at desc);
alter table public.q_ai_usage enable row level security;
drop policy if exists q_ai_usage_sel on public.q_ai_usage;
create policy q_ai_usage_sel on public.q_ai_usage for select using (user_id = auth.uid());
drop policy if exists q_ai_usage_ins on public.q_ai_usage;
create policy q_ai_usage_ins on public.q_ai_usage for insert with check (user_id = auth.uid());
