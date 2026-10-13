-- Break80 database (Supabase / Postgres).
--
-- The browser never touches these tables directly: row-level security is on with
-- no policies, so the public (anon) key can only call the b80_* functions below.
-- Every function checks the shared app password, and anything that writes a
-- player's data also checks that player's PIN. Both are stored as bcrypt hashes.
--
-- Safe to re-run. Set the password and golf API key separately, e.g.:
--   insert into b80_config (id, password_hash, golf_api_key)
--   values (1, extensions.crypt('<password>', extensions.gen_salt('bf')), '<key>')
--   on conflict (id) do update set password_hash = excluded.password_hash, golf_api_key = excluded.golf_api_key;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.b80_config (
  id            int primary key default 1 check (id = 1),
  password_hash text not null,
  golf_api_key  text
);

create table if not exists public.b80_players (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 1 and 30),
  pin_hash     text not null,
  failed_pins  int not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists b80_players_name_key on public.b80_players (lower(btrim(name)));

create table if not exists public.b80_rounds (
  id         text primary key,
  player_id  uuid not null references public.b80_players (id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists b80_rounds_player_idx on public.b80_rounds (player_id);

create table if not exists public.b80_courses (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.b80_config  enable row level security;
alter table public.b80_players enable row level security;
alter table public.b80_rounds  enable row level security;
alter table public.b80_courses enable row level security;
revoke all on public.b80_config, public.b80_players, public.b80_rounds, public.b80_courses from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

create or replace function public.b80_assert_pw(pw text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if pw is null or not exists (select 1 from b80_config where password_hash = crypt(pw, password_hash)) then
    raise exception 'bad_password';
  end if;
end $$;

-- Returns 'ok' | 'bad_pin' | 'locked' | 'no_player'. Never raises, so the
-- failed-attempt counter survives (a raise would roll it back).
-- 5 wrong PINs locks the profile for 15 minutes.
create or replace function public.b80_pin_status(p_player uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare p b80_players;
begin
  select * into p from b80_players where id = p_player for update;
  if not found then return 'no_player'; end if;
  if p.locked_until is not null and p.locked_until > now() then return 'locked'; end if;
  if p_pin is null or p.pin_hash <> crypt(p_pin, p.pin_hash) then
    update b80_players
       set failed_pins = failed_pins + 1,
           locked_until = case when failed_pins + 1 >= 5 then now() + interval '15 minutes' end
     where id = p_player;
    return 'bad_pin';
  end if;
  if p.failed_pins > 0 then
    update b80_players set failed_pins = 0, locked_until = null where id = p_player;
  end if;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Public API (called via /rest/v1/rpc/<name>)
-- ---------------------------------------------------------------------------

-- Password check + everything the app needs to start.
create or replace function public.b80_login(pw text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform b80_assert_pw(pw);
  return jsonb_build_object(
    'golfApiKey', (select golf_api_key from b80_config where id = 1),
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by lower(name)) from b80_players), '[]'::jsonb)
  );
end $$;

-- All players, all rounds (everyone's scores are visible to everyone in the app), shared courses.
create or replace function public.b80_sync(pw text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform b80_assert_pw(pw);
  return jsonb_build_object(
    'golfApiKey', (select golf_api_key from b80_config where id = 1),
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by lower(name)) from b80_players), '[]'::jsonb),
    'rounds',  coalesce((select jsonb_agg(data || jsonb_build_object('playerId', player_id)) from b80_rounds), '[]'::jsonb),
    'courses', coalesce((select jsonb_agg(data) from b80_courses), '[]'::jsonb)
  );
end $$;

create or replace function public.b80_create_player(pw text, p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare new_id uuid;
begin
  perform b80_assert_pw(pw);
  if p_name is null or char_length(btrim(p_name)) not between 1 and 30 then return jsonb_build_object('error', 'bad_name'); end if;
  if p_pin is null or p_pin !~ '^\d{4}$' then return jsonb_build_object('error', 'bad_pin_format'); end if;
  if exists (select 1 from b80_players where lower(btrim(name)) = lower(btrim(p_name))) then
    return jsonb_build_object('error', 'name_taken');
  end if;
  insert into b80_players (name, pin_hash) values (btrim(p_name), crypt(p_pin, gen_salt('bf'))) returning id into new_id;
  return jsonb_build_object('id', new_id, 'name', btrim(p_name));
end $$;

create or replace function public.b80_verify_pin(pw text, p_player uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare st text;
begin
  perform b80_assert_pw(pw);
  st := b80_pin_status(p_player, p_pin);
  return case when st = 'ok' then jsonb_build_object('ok', true) else jsonb_build_object('error', st) end;
end $$;

-- Upsert a batch of the player's rounds. A round id that belongs to someone else is skipped.
create or replace function public.b80_save_rounds(pw text, p_player uuid, p_pin text, p_rounds jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare st text; r jsonb; saved int := 0;
begin
  perform b80_assert_pw(pw);
  st := b80_pin_status(p_player, p_pin);
  if st <> 'ok' then return jsonb_build_object('error', st); end if;
  if jsonb_typeof(p_rounds) <> 'array' or jsonb_array_length(p_rounds) > 50 then return jsonb_build_object('error', 'bad_payload'); end if;
  for r in select * from jsonb_array_elements(p_rounds) loop
    continue when r->>'id' is null or pg_column_size(r) > 200000;
    insert into b80_rounds (id, player_id, data, updated_at)
    values (r->>'id', p_player, r - 'playerId', now())
    on conflict (id) do update set data = excluded.data, updated_at = now()
      where b80_rounds.player_id = p_player;
    saved := saved + 1;
  end loop;
  return jsonb_build_object('ok', true, 'saved', saved);
end $$;

create or replace function public.b80_delete_round(pw text, p_player uuid, p_pin text, p_round text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare st text;
begin
  perform b80_assert_pw(pw);
  st := b80_pin_status(p_player, p_pin);
  if st <> 'ok' then return jsonb_build_object('error', st); end if;
  delete from b80_rounds where id = p_round and player_id = p_player;
  return jsonb_build_object('ok', true);
end $$;

-- Scorecards are shared so a course only has to be looked up (or typed in) once.
create or replace function public.b80_save_course(pw text, p_course jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform b80_assert_pw(pw);
  if p_course->>'id' is null or pg_column_size(p_course) > 100000 then return jsonb_build_object('error', 'bad_payload'); end if;
  insert into b80_courses (id, data, updated_at) values (p_course->>'id', p_course, now())
  on conflict (id) do update set data = excluded.data, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Lock down execute rights: helpers are internal, the API is callable with the anon key.
revoke execute on function public.b80_assert_pw(text) from public, anon, authenticated;
revoke execute on function public.b80_pin_status(uuid, text) from public, anon, authenticated;
grant execute on function
  public.b80_login(text), public.b80_sync(text), public.b80_create_player(text, text, text),
  public.b80_verify_pin(text, uuid, text), public.b80_save_rounds(text, uuid, text, jsonb),
  public.b80_delete_round(text, uuid, text, text), public.b80_save_course(text, jsonb)
to anon, authenticated;
