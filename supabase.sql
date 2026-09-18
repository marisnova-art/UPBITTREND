-- UPBIT TREND & ENTRY SCANNER — 기기 간 동기화용 테이블
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행하세요.

create table if not exists public.holdings (
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  market     text        not null,
  avg_price  numeric     not null check (avg_price > 0),
  qty        numeric     not null check (qty > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, market)
);

create table if not exists public.favorites (
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  market     text        not null,
  created_at timestamptz not null default now(),
  primary key (user_id, market)
);

alter table public.holdings  enable row level security;
alter table public.favorites enable row level security;

-- 본인 데이터만 읽고 쓸 수 있게 제한 (anon key가 공개되어도 남의 데이터는 볼 수 없음)
drop policy if exists "own holdings" on public.holdings;
create policy "own holdings" on public.holdings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own favorites" on public.favorites;
create policy "own favorites" on public.favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 다른 기기의 변경을 실시간으로 받기 위한 설정
alter publication supabase_realtime add table public.holdings;
alter publication supabase_realtime add table public.favorites;
