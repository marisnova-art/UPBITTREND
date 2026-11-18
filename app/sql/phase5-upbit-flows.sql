-- QUANTERA 8차: 업비트 원화 입금·출금 내역 (전체 기간 손익 계산용)
-- PC 도우미가 연결 코드로 올리고(하루 몇 번), 읽기는 본인만. 사용자마다 한 줄(전체 목록을 통째로 바꿈).
-- flows: [{ "t": "d"(입금) | "w"(출금), "at": "ISO 시각", "amt": 금액, "fee": 수수료 }]
create table if not exists public.q_upbit_flows (
  user_id uuid primary key references auth.users(id) on delete cascade,
  flows jsonb not null,
  at timestamptz not null default now()
);
alter table public.q_upbit_flows enable row level security;
drop policy if exists "own read" on public.q_upbit_flows;
create policy "own read" on public.q_upbit_flows for select using (user_id = auth.uid());

create or replace function public.q_upbit_flows_push(p_code text, p_flows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare uid uuid;
begin
  if p_code is null or length(p_code) < 16 then raise exception 'invalid_code'; end if;
  select user_id into uid from q_upbit_links
   where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex') and revoked_at is null;
  if uid is null then raise exception 'invalid_code'; end if;
  if jsonb_typeof(p_flows) <> 'array' or jsonb_array_length(p_flows) > 20000 then raise exception 'bad_flows'; end if;
  insert into q_upbit_flows (user_id, flows, at) values (uid, p_flows, now())
  on conflict (user_id) do update set flows = excluded.flows, at = excluded.at;
  return jsonb_build_object('ok', true, 'n', jsonb_array_length(p_flows));
end;
$$;
revoke all on function public.q_upbit_flows_push(text, jsonb) from public;
grant execute on function public.q_upbit_flows_push(text, jsonb) to anon, authenticated;
