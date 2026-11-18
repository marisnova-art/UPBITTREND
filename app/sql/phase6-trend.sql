-- QUANTERA 8차: 트렌드 리포트 (뉴스 AI 요약 · 일간 · 주간). Supabase SQL 편집기에 붙여 넣고 실행하세요. 여러 번 실행해도 안전해요.
-- /api/trend 가 로그인한 사용자 토큰으로 만들어 저장하고, 로그인한 사용자는 모두 같이 봐요(같은 리포트를 다시 만들지 않아 AI 한도 절약).
create table if not exists public.q_trend (
  id text primary key,            -- 'n:<해시>' 뉴스 · 'daily-YYYY-MM-DD' · 'weekly-YYYY-MM-DD' · 'news-meta'
  kind text not null,             -- news | daily | weekly | meta
  at timestamptz not null default now(),
  data jsonb not null
);
create index if not exists q_trend_kind_at on public.q_trend (kind, at desc);
alter table public.q_trend enable row level security;
drop policy if exists q_trend_sel on public.q_trend;
create policy q_trend_sel on public.q_trend for select to authenticated using (true);
drop policy if exists q_trend_ins on public.q_trend;
create policy q_trend_ins on public.q_trend for insert to authenticated with check (true);
drop policy if exists q_trend_upd on public.q_trend;
create policy q_trend_upd on public.q_trend for update to authenticated using (true) with check (true);
