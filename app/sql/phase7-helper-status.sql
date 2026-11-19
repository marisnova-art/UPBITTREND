-- QUANTERA: PC 도우미가 업비트 오류(허용 IP 바뀜 등)를 올려 둠 → 앱 알림함에 "IP 바뀜 · 새 IP" 긴급 알림
-- q_upbit_balances 한 줄에 오류 칸(err, err_at, ip)을 더함. 잔고를 다시 올리면 오류는 지워짐.
alter table public.q_upbit_balances add column if not exists err text;
alter table public.q_upbit_balances add column if not exists err_at timestamptz;
alter table public.q_upbit_balances add column if not exists ip text;

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
  insert into q_upbit_balances (user_id, accounts, at, err, err_at) values (uid, p_accounts, now(), null, null)
  on conflict (user_id) do update set accounts = excluded.accounts, at = excluded.at, err = null, err_at = null;
  return jsonb_build_object('ok', true, 'n', jsonb_array_length(p_accounts));
end;
$$;
revoke all on function public.q_upbit_balances_push(text, jsonb) from public;
grant execute on function public.q_upbit_balances_push(text, jsonb) to anon, authenticated;

create or replace function public.q_upbit_status_push(p_code text, p_err text, p_ip text)
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
  update q_upbit_balances set err = left(coalesce(p_err, ''), 300), err_at = now(), ip = left(nullif(p_ip, ''), 64) where user_id = uid;
  if not found then
    insert into q_upbit_balances (user_id, accounts, at, err, err_at, ip) values (uid, '[]'::jsonb, to_timestamp(0), left(coalesce(p_err, ''), 300), now(), left(nullif(p_ip, ''), 64));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.q_upbit_status_push(text, text, text) from public;
grant execute on function public.q_upbit_status_push(text, text, text) to anon, authenticated;
