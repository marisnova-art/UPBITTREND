-- =====================================================================
-- UPBIT TREND & ENTRY SCANNER — 기기 간 동기화용 Supabase 설정
-- Supabase 대시보드 → SQL Editor → 새 쿼리에 전체 붙여넣고 Run.
-- 여러 번 실행해도 안전합니다(이미 있는 것은 건너뜀).
-- =====================================================================

-- 1) 보유 종목
create table if not exists public.holdings (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  market     text not null,
  avg_price  double precision not null,
  qty        double precision not null,
  updated_at timestamptz not null default now()
);
create unique index if not exists holdings_user_market on public.holdings (user_id, market);

-- 2) 즐겨찾기
create table if not exists public.favorites (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  market     text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists favorites_user_market on public.favorites (user_id, market);

-- 3) 화면 설정(필터·정렬·자동 갱신·분석 기준 등)
create table if not exists public.user_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 4) 본인 데이터만 읽고 쓰기 (RLS)
alter table public.holdings      enable row level security;
alter table public.favorites     enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "own rows" on public.holdings;
drop policy if exists "own rows" on public.favorites;
drop policy if exists "own rows" on public.user_settings;
create policy "own rows" on public.holdings      for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.favorites     for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.user_settings for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.holdings, public.favorites, public.user_settings to authenticated;

-- 5) 실시간 반영(다른 기기에서 바꾸면 즉시 반영). 삭제 이벤트도 받으려면 replica identity full 필요.
alter table public.holdings      replica identity full;
alter table public.favorites     replica identity full;
alter table public.user_settings replica identity full;
do $$
declare t text;
begin
  foreach t in array array['holdings','favorites','user_settings'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
