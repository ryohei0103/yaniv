-- ヤニブ オンライン対戦（Supabase）
-- yaniv_rooms: 手札・山札を含む完全な状態。ポリシーなし＝Edge Function（service role）だけが読み書きできる
create table public.yaniv_rooms (
  code text primary key,
  state jsonb not null,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.yaniv_rooms enable row level security;

-- yaniv_public: 全員に見せてよい情報だけ（手札の中身は含まない）。Realtime で配信
create table public.yaniv_public (
  code text primary key references public.yaniv_rooms(code) on delete cascade,
  view jsonb not null,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.yaniv_public enable row level security;
create policy "yaniv_public is readable" on public.yaniv_public
  for select to anon, authenticated using (true);

alter publication supabase_realtime add table public.yaniv_public;
