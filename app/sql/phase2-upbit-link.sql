-- QUANTERA: 업비트 자동 올리기 (PC 도우미 → 연결 코드로 거래일지에 바로 추가)
-- 연결 코드는 앱에서 만들고, 서버에는 코드의 SHA-256 값만 저장합니다.
create table if not exists public.q_upbit_links (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_added int,
  revoked_at timestamptz
);
alter table public.q_upbit_links enable row level security;
drop policy if exists "own read" on public.q_upbit_links;
drop policy if exists "own insert" on public.q_upbit_links;
drop policy if exists "own update" on public.q_upbit_links;
create policy "own read" on public.q_upbit_links for select using (user_id = auth.uid());
create policy "own insert" on public.q_upbit_links for insert with check (user_id = auth.uid());
create policy "own update" on public.q_upbit_links for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 도우미가 부르는 함수: 코드가 맞으면 그 계정의 거래일지에 새 체결만 추가 (같은 주문은 건너뜀)
create or replace function public.q_upbit_push(p_code text, p_orders jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  lid bigint;
  n int := 0;
begin
  if p_code is null or length(p_code) < 16 then raise exception 'invalid_code'; end if;
  select id, user_id into lid, uid from q_upbit_links
   where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex') and revoked_at is null;
  if uid is null then raise exception 'invalid_code'; end if;
  if jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) > 5000 then raise exception 'bad_orders'; end if;

  insert into q_trades (user_id, trade_no, external_id, source, symbol, side, price, qty, fee, executed_at, guide)
  select uid, 'U-' || left(o->>'uuid', 13), o->>'uuid', 'upbit_import', 'upbit:' || (o->>'market'),
         case when o->>'side' = 'bid' then 'buy' else 'sell' end,
         coalesce(t.funds / nullif(t.vol, 0), (o->>'price')::float8),
         (o->>'executed_volume')::float8,
         coalesce((o->>'paid_fee')::float8, 0),
         coalesce(t.last_at, (o->>'created_at')::timestamptz, now()),
         jsonb_build_object('upbit', jsonb_build_object('ord_type', o->>'ord_type', 'trades', t.ntr, 'via', 'helper'))
    from jsonb_array_elements(p_orders) o
    cross join lateral (
      select nullif(sum((x->>'funds')::float8), 0) funds, sum((x->>'volume')::float8) vol,
             max((x->>'created_at')::timestamptz) last_at, count(*)::int ntr
        from jsonb_array_elements(coalesce(o->'trades', '[]'::jsonb)) x
    ) t
   where o->>'uuid' is not null
     and coalesce((o->>'executed_volume')::float8, 0) > 0
     and o->>'market' like 'KRW-%'
     and coalesce(t.funds / nullif(t.vol, 0), (o->>'price')::float8) > 0
     and not exists (select 1 from q_trades q where q.user_id = uid and q.external_id = o->>'uuid')
  on conflict (user_id, trade_no) do nothing;
  get diagnostics n = row_count;

  update q_upbit_links set last_used_at = now(), last_added = n where id = lid;
  return jsonb_build_object('added', n, 'sent', jsonb_array_length(p_orders));
end;
$$;
revoke all on function public.q_upbit_push(text, jsonb) from public;
grant execute on function public.q_upbit_push(text, jsonb) to anon, authenticated;
