-- Pumpers City: prize table. Run once in Supabase → SQL Editor → New query → Run.
create extension if not exists pgcrypto;

create table if not exists prizes (
  id                uuid primary key default gen_random_uuid(),
  wallet            text not null,                 -- winner's wallet
  amount            numeric not null,              -- prize in whole $PUMP
  district          text,                          -- where the box was opened
  status            text not null default 'ready'  -- ready → sending → sent (held = under review)
                    check (status in ('ready', 'sending', 'sent', 'held')),
  signature         text,                          -- payout transaction
  last_valid_height bigint,                        -- lets a stuck payout be settled safely
  note              text,
  created_at        timestamptz not null default now(),
  claimed_at        timestamptz,
  sent_at           timestamptz
);
create index if not exists prizes_wallet_idx on prizes (wallet, created_at desc);

-- only the server (service key) may read or write; the public anon key gets nothing
alter table prizes enable row level security;

-- ================= GAME SERVER (multiplayer) =================
-- Safe to run again: it only adds what is missing.

-- XP and the leaderboard
create table if not exists players (
  wallet     text primary key,
  name       text,
  xp         bigint  not null default 0,
  opened     int     not null default 0,
  found      numeric not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists players_xp_idx on players (xp desc);
alter table players enable row level security;

-- Prize waves. One row; edit it in Table Editor → game_settings.
--   prizes_left    how many prizes are still to be found in this wave (set 10 to start a wave of 10)
--   prizes_active  how many of them are hidden in boxes at the same time
--   prize_amount   $PUMP per prize in this wave
--   wave           raise by 1 when you start a new wave
--   max_wins_per_wallet  how many prizes one wallet can win in a wave
--   boxes_open     false = nobody can open boxes (walking around still works)
create table if not exists game_settings (
  id                  int primary key default 1 check (id = 1),
  boxes_open          boolean not null default true,
  prize_amount        numeric not null default 0,
  prizes_active       int     not null default 5,
  prizes_left         int     not null default 0,
  wave                int     not null default 1,
  max_wins_per_wallet int     not null default 1
);
insert into game_settings (id) values (1) on conflict (id) do nothing;
alter table game_settings enable row level security;

alter table prizes add column if not exists wave int;

-- Called by the game server when someone opens a prize box. Takes one prize from the wave and
-- records it for the wallet in one step, so a wave can never give out more than prizes_left.
create or replace function take_prize(p_wallet text, p_district text) returns numeric
language plpgsql as $$
declare s game_settings; won int;
begin
  select * into s from game_settings where id = 1 for update;
  if s is null or not s.boxes_open or s.prizes_left <= 0 or s.prize_amount <= 0 then return null; end if;
  select count(*) into won from prizes where wallet = p_wallet and wave = s.wave;
  if won >= s.max_wins_per_wallet then return null; end if;
  update game_settings set prizes_left = prizes_left - 1 where id = 1;
  insert into prizes (wallet, amount, district, wave) values (p_wallet, s.prize_amount, p_district, s.wave);
  return s.prize_amount;
end $$;
revoke execute on function take_prize(text, text) from public, anon, authenticated;

-- totals for the site counter
create or replace view prize_stats as
  select coalesce(sum(amount), 0) as won,
         coalesce(sum(amount) filter (where status = 'sent'), 0) as sent,
         count(*) as wins
  from prizes;
revoke all on prize_stats from anon, authenticated;

-- ================= DAILY LEADERBOARD =================
-- The board ranks each day's XP (19:00 to 19:00 UTC; a day is named after the date it starts on). At the reset the game server calls award_daily(),
-- which gives the top 3 their prizes in MY PRIZES. Amounts: game_settings.daily_top (1st, 2nd, 3rd).
alter table players add column if not exists day date;
alter table players add column if not exists day_xp bigint not null default 0;
create index if not exists players_day_idx on players (day, day_xp desc);
alter table game_settings add column if not exists daily_top numeric[] not null default '{10000,5000,2500}';
-- first day that pays out (launch: 28 Oct 2026, 19:00 UTC). Earlier test days never get prizes.
alter table game_settings add column if not exists daily_start date;
update game_settings set daily_start = '2026-10-28' where id = 1 and daily_start is null;

create table if not exists daily_results (
  day    date not null,
  rank   int  not null,          -- 1, 2, 3 (0 = nobody played that day)
  wallet text,
  xp     bigint,
  amount numeric,
  primary key (day, rank)
);
alter table daily_results enable row level security;

create or replace function award_daily(p_day date) returns int
language plpgsql as $$
declare s game_settings; r record; i int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('award_daily'));
  if exists (select 1 from daily_results where day = p_day) then return 0; end if;   -- already done
  select * into s from game_settings where id = 1;
  if s.daily_start is not null and p_day < s.daily_start then return 0; end if;       -- before launch: no prizes
  for r in select wallet, day_xp from players
           where day = p_day and day_xp > 0
           order by day_xp desc, updated_at asc
           limit coalesce(array_length(s.daily_top, 1), 0) loop
    i := i + 1;
    insert into daily_results (day, rank, wallet, xp, amount) values (p_day, i, r.wallet, r.day_xp, s.daily_top[i]);
    if s.daily_top[i] > 0 then
      insert into prizes (wallet, amount, district) values (r.wallet, s.daily_top[i], 'DAILY TOP ' || i);
    end if;
  end loop;
  if i = 0 then insert into daily_results (day, rank) values (p_day, 0); end if;
  return i;
end $$;
revoke execute on function award_daily(date) from public, anon, authenticated;

-- ================= PLAYER NAMES =================
alter table players add column if not exists name_key text;   -- lowercase name, for "is this name taken"
create index if not exists players_name_idx on players (name_key);

-- ================= SURPRISE PILLS =================
-- one wandering pill per district; after it is caught a new one appears 12 hours later
create table if not exists surprise_pills (
  map        text primary key,
  respawn_at timestamptz,
  caught_by  text,
  caught_at  timestamptz
);
alter table surprise_pills enable row level security;

-- ================= ENERGY =================
-- opening a box costs 1 energy; it refills while you hold (filled in by the game server every 10 minutes)
create table if not exists energy (
  wallet text primary key,
  e      numeric not null default 0,      -- energy in the tank
  power  numeric not null default 0,      -- refill per hour from what the wallet held at the last check
  at     timestamptz not null default now()
);
alter table energy enable row level security;
alter table energy add column if not exists fresh boolean not null default false;
alter table game_settings add column if not exists energy_launch timestamptz;   -- set by the server at the first holder check

-- Guests keep their name by network for 30 days, so coming back as a guest skips the name screen.
create table if not exists guest_names (
  ip         text primary key,
  name       text not null,
  updated_at timestamptz not null default now()
);
alter table guest_names enable row level security;
