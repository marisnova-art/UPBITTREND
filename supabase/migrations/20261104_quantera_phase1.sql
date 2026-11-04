-- =====================================================================
-- QUANTERA PHASE 1 — 새 테이블 추가 (기존 holdings / favorites / user_settings 는 건드리지 않음)
-- 모든 새 테이블은 q_ 접두사. 여러 번 실행해도 안전합니다.
-- 원본 캔들은 여기에 저장하지 않습니다(수집 서버 디스크). 이곳엔 기록·요약·통계만.
-- =====================================================================

-- ---------- 공용(읽기 전용) 데이터: 서버(service_role)만 씀 ----------
create table if not exists public.q_instruments (
  symbol      text primary key,                 -- 'upbit:KRW-BTC'
  exchange    text not null,                    -- 'upbit' | 'kis' | 'kiwoom' | 'us'
  market      text not null,                    -- 거래소 고유 코드 'KRW-BTC'
  name        text not null,
  name_en     text,
  quote_ccy   text not null default 'KRW',
  warning     boolean not null default false,
  listed_at   date,                             -- 처음 발견한 날(신규 상장 감지)
  delisted_at date,
  updated_at  timestamptz not null default now()
);

create table if not exists public.q_scan_results (   -- 종목별 최신 스캔 결과 1행
  symbol     text primary key references public.q_instruments(symbol) on delete cascade,
  stage      text, status text, total int, rank double precision,
  peter      text,                                  -- 규칙 기반 한 줄 의견
  data       jsonb not null default '{}'::jsonb,
  scanned_at timestamptz not null default now()
);

create table if not exists public.q_instrument_profiles (  -- 변동폭 프로필
  symbol        text not null references public.q_instruments(symbol) on delete cascade,
  tf            text not null,                      -- '5m' '1h' '1d' '1w' '1M'
  lookback_days int  not null default 90,
  avg_range     double precision, typical_range double precision,
  max_range     double precision, min_range double precision,
  samples       int,
  updated_at    timestamptz not null default now(),
  primary key (symbol, tf)
);

create table if not exists public.q_pattern_events (  -- 패턴 발생 기록(백테스트 근거)
  id          bigint generated always as identity primary key,
  symbol      text not null references public.q_instruments(symbol) on delete cascade,
  pattern     text not null,
  tf          text not null,
  occurred_at timestamptz not null,
  entry_price double precision,
  outcome     jsonb,                                -- {ret_1d, ret_7d, mfe, mae, ...}
  created_at  timestamptz not null default now(),
  unique (symbol, pattern, tf, occurred_at)
);
create index if not exists q_pattern_events_sym on public.q_pattern_events (symbol, occurred_at desc);

create table if not exists public.q_pattern_stats (   -- 패턴 성적표
  pattern     text not null,
  tf          text not null,
  scope       text not null default 'all',          -- 'all' 또는 심볼
  samples     int not null default 0,
  win_rate    double precision,
  expectancy  double precision,                     -- 수수료·슬리피지 뺀 기대수익(%)
  avg_win     double precision, avg_loss double precision,
  updated_at  timestamptz not null default now(),
  primary key (pattern, tf, scope)
);

create table if not exists public.q_guides (          -- 피터 매매 가이드 (차트 분석 기준)
  id          bigint generated always as identity primary key,
  symbol      text not null references public.q_instruments(symbol) on delete cascade,
  stance      text not null default 'watch',        -- 'buy_zone' | 'watch' | 'avoid'
  buy_lo      double precision, buy_hi double precision,
  sell1       double precision, sell2 double precision, stop double precision,
  basis       jsonb not null default '{}'::jsonb,   -- 근거(패턴, 레벨, 성적표)
  created_at  timestamptz not null default now()
);
create index if not exists q_guides_sym on public.q_guides (symbol, created_at desc);

-- ---------- 사용자 데이터 ----------
create table if not exists public.q_user_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  layout     jsonb not null default '{}'::jsonb,    -- PC 패널 크기·접힘
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.q_watchlist (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text not null,
  group_name text not null default '기본',
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

create table if not exists public.q_accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  exchange   text not null default 'upbit',
  kind       text not null check (kind in ('manual','paper','real')),
  name       text not null,
  cash       double precision not null default 0,   -- 모의계좌 잔고
  created_at timestamptz not null default now()
);
create index if not exists q_accounts_user on public.q_accounts (user_id);

-- 매매 기록: 쌓기만 함(append-only). 수정이 필요하면 voids_trade_id 로 정정 기록을 새로 추가.
create table if not exists public.q_trades (
  id             bigint generated always as identity primary key,
  trade_no       text not null,                     -- 'T-0001' (사용자별 일련번호)
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id     uuid references public.q_accounts(id),
  symbol         text not null,
  side           text not null check (side in ('buy','sell')),
  price          double precision not null check (price > 0),
  qty            double precision not null check (qty > 0),
  fee            double precision not null default 0,
  executed_at    timestamptz not null default now(),
  source         text not null default 'manual' check (source in ('manual','paper','upbit_import','carry_over','real')),
  external_id    text,                              -- 업비트 체결 uuid (가져오기 중복 방지)
  strategy       text,
  reason         text,                              -- 판단 이유
  guide          jsonb,                             -- 당시 가이드(매수 구간·매도가·손절가)
  voids_trade_id bigint references public.q_trades(id),
  created_at     timestamptz not null default now(),
  unique (user_id, trade_no)
);
create unique index if not exists q_trades_external on public.q_trades (user_id, source, external_id) where external_id is not null;
create index if not exists q_trades_user_sym on public.q_trades (user_id, symbol, executed_at desc);

create table if not exists public.q_trade_links (     -- 매도 ↔ 매수 연결 (어느 매수분을 팔았나)
  sell_id   bigint not null references public.q_trades(id),
  buy_id    bigint not null references public.q_trades(id),
  qty       double precision not null check (qty > 0),
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sell_id, buy_id)
);

create table if not exists public.q_trade_snapshots ( -- 당시 차트(체결 순간 캔들·지표 요약, 약 20KB)
  trade_id   bigint primary key references public.q_trades(id),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.q_journal_days (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null,
  note       text,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists public.q_instrument_notes (   -- 종목 위키 메모 (쌓기만 함)
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text not null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists q_notes_user_sym on public.q_instrument_notes (user_id, symbol, created_at desc);

create table if not exists public.q_strategies (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code       text not null,                         -- 'A' 'B' 'C'
  name       text not null,
  params     jsonb not null default '{}'::jsonb,
  enabled    boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, code)
);

create table if not exists public.q_backtest_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  strategy_id uuid references public.q_strategies(id) on delete set null,
  params      jsonb not null default '{}'::jsonb,
  result      jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.q_orders (            -- 모의·실주문. client_order_id 로 중복 주문 차단
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id        uuid not null references public.q_accounts(id),
  client_order_id   text not null,
  exchange_order_id text,
  symbol            text not null,
  side              text not null check (side in ('buy','sell')),
  ord_type          text not null check (ord_type in ('limit','market')),
  price             double precision, qty double precision,
  status            text not null default 'pending' check (status in ('pending','open','filled','partial','cancelled','rejected')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, client_order_id)
);

create table if not exists public.q_alert_rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text,                                  -- null = 즐겨찾기·보유 전체
  kind       text not null,                         -- 'price' 'rebuy' 'pattern' 'volatility' 'stop' 'new_listing'
  params     jsonb not null default '{}'::jsonb,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.q_alerts (            -- 알림·이벤트 로그
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text,
  kind       text not null,
  message    text not null,
  data       jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists q_alerts_user on public.q_alerts (user_id, created_at desc);

-- ---------- 서버 전용 (브라우저 접근 불가) ----------
create table if not exists public.q_api_credentials (   -- 거래소 키는 암호화해서 서버만 읽음. 출금 권한 키 금지.
  user_id    uuid not null references auth.users(id) on delete cascade,
  exchange   text not null,
  key_ref    text not null,                         -- 실제 키가 아닌 서버 비밀 저장소 참조
  scopes     text[] not null default '{}',
  ip_allow   text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (user_id, exchange)
);
create table if not exists public.q_system_status (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- 보유 현황 뷰 (기록에서 계산, 저장 안 함) ----------
create or replace view public.q_positions_v with (security_invoker = true) as
select t.user_id, t.account_id, t.symbol,
       sum(case when t.side='buy'  then t.qty else 0 end) as buy_qty,
       sum(case when t.side='sell' then t.qty else 0 end) as sell_qty,
       sum(case when t.side='buy'  then t.qty else -t.qty end) as net_qty,
       sum(case when t.side='buy'  then t.price*t.qty + t.fee else 0 end)
         / nullif(sum(case when t.side='buy' then t.qty else 0 end), 0) as avg_buy_price,
       count(*) filter (where t.side='buy')  as buys,
       count(*) filter (where t.side='sell') as sells,
       max(t.executed_at) as last_trade_at
from public.q_trades t
where t.voids_trade_id is null
  and not exists (select 1 from public.q_trades v where v.voids_trade_id = t.id)
group by t.user_id, t.account_id, t.symbol;

-- ---------- RLS ----------
do $$
declare t text;
begin
  -- 공용 데이터: 누구나 읽기, 쓰기는 service_role 만(정책 없음)
  foreach t in array array['q_instruments','q_scan_results','q_instrument_profiles','q_pattern_events','q_pattern_stats','q_guides'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;

  -- 사용자 데이터: 본인 것만 전부
  foreach t in array array['q_user_settings','q_watchlist','q_accounts','q_journal_days','q_strategies','q_backtest_runs','q_orders','q_alert_rules','q_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;

  -- 쌓기만 하는 기록: 본인 것 읽기·추가만 (수정·삭제 불가)
  foreach t in array array['q_trades','q_trade_links','q_trade_snapshots','q_instrument_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own read" on public.%I', t);
    execute format('drop policy if exists "own insert" on public.%I', t);
    execute format('create policy "own read" on public.%I for select to authenticated using (auth.uid() = user_id)', t);
    execute format('create policy "own insert" on public.%I for insert to authenticated with check (auth.uid() = user_id)', t);
    execute format('revoke update, delete on public.%I from anon, authenticated', t);
    execute format('grant select, insert on public.%I to authenticated', t);
  end loop;

  -- 서버 전용: RLS 켜고 정책 없음 → 브라우저에서 접근 불가
  foreach t in array array['q_api_credentials','q_system_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

grant select on public.q_positions_v to authenticated;

-- 정정 기록은 본인 거래만 가리킬 수 있게
create or replace function public.q_trades_check_void() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.voids_trade_id is not null and not exists (
    select 1 from public.q_trades where id = new.voids_trade_id and user_id = new.user_id) then
    raise exception 'voids_trade_id must reference your own trade';
  end if;
  return new;
end $$;
drop trigger if exists q_trades_check_void on public.q_trades;
create trigger q_trades_check_void before insert on public.q_trades
  for each row execute function public.q_trades_check_void();

-- 실시간: 알림·주문·기록
do $$
declare t text;
begin
  foreach t in array array['q_alerts','q_orders','q_trades','q_watchlist'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- ---------- 기존 데이터 복사 (원본 테이블은 그대로 둠, 이미 복사됐으면 건너뜀) ----------
-- 1) 사용자마다 '기초 이월' 수동 계좌
insert into public.q_accounts (user_id, exchange, kind, name)
select distinct h.user_id, 'upbit', 'manual', '업비트 (수동 기록)'
from public.holdings h
where not exists (select 1 from public.q_accounts a where a.user_id = h.user_id and a.kind = 'manual');

-- 2) 보유 종목 → 기초 이월 매수 기록
insert into public.q_trades (trade_no, user_id, account_id, symbol, side, price, qty, fee, executed_at, source, reason)
select 'T-' || lpad((row_number() over (partition by h.user_id order by h.updated_at, h.market))::text, 4, '0'),
       h.user_id,
       (select a.id from public.q_accounts a where a.user_id = h.user_id and a.kind = 'manual' order by a.created_at limit 1),
       'upbit:' || h.market, 'buy', h.avg_price, h.qty, 0, h.updated_at, 'carry_over', '기초 이월 (기존 보유 종목)'
from public.holdings h
where h.avg_price > 0 and h.qty > 0
  and not exists (select 1 from public.q_trades t where t.user_id = h.user_id);

-- 3) 즐겨찾기 → 관심 목록
insert into public.q_watchlist (user_id, symbol, sort, created_at)
select f.user_id, 'upbit:' || f.market, (row_number() over (partition by f.user_id order by f.created_at))::int, f.created_at
from public.favorites f
on conflict (user_id, symbol) do nothing;
