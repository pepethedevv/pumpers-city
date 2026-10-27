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
