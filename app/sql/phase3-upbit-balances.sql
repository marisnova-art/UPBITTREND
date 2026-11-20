-- QUANTERA: PC 도우미가 업비트 잔고(보유 코인·평단)를 올려 둠 → 보유 자산을 업비트와 똑같이 보여 줌
-- 사용자마다 한 줄(최신 잔고만). 연결 코드로만 쓸 수 있고, 읽기는 본인만.
create table if not exists public.q_upbit_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  accounts jsonb not null,
  at timestamptz not null default now()
);
alter table public.q_upbit_balances enable row level security;
drop policy if exists "own read" on public.q_upbit_balances;
create policy "own read" on public.q_upbit_balances for select using (user_id = auth.uid());

create or replace function public.q_upbit_balances_push(p_code text, p_accounts jsonb)
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
  if jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 1000 then raise exception 'bad_accounts'; end if;
  insert into q_upbit_balances (user_id, accounts, at) values (uid, p_accounts, now())
  on conflict (user_id) do update set accounts = excluded.accounts, at = excluded.at;
  return jsonb_build_object('ok', true, 'n', jsonb_array_length(p_accounts));
end;
$$;
revoke all on function public.q_upbit_balances_push(text, jsonb) from public;
grant execute on function public.q_upbit_balances_push(text, jsonb) to anon, authenticated;
