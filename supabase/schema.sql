create extension if not exists pgcrypto;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_email text not null,
  recipient_name text not null,
  birthday_message text not null,
  notes text,
  theme_id text not null,
  package_id text not null,
  deployment_plan text,
  addons jsonb not null default '[]'::jsonb,
  total_usd numeric(10,2) not null check (total_usd >= 0),
  status text not null default 'payment_pending',
  payment_status text not null default 'unpaid',
  payment_provider text,
  payment_provider_order_id text,
  vercel_url text,
  content_status text not null default 'pending',
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.orders add column if not exists recipient_name text;
alter table public.orders add column if not exists birthday_message text;
alter table public.orders add column if not exists notes text;
alter table public.orders add column if not exists content_status text not null default 'pending';
alter table public.orders add column if not exists paid_at timestamptz;

create index if not exists orders_email_idx on public.orders(customer_email);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_payment_provider_id_idx on public.orders(payment_provider_order_id);

create table if not exists public.order_media (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  storage_path text not null,
  original_name text,
  media_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public)
values ('order-media', 'order-media', false)
on conflict (id) do nothing;

alter table public.orders enable row level security;
alter table public.order_media enable row level security;

-- No public insert/update policies are created here.
-- The Vercel API uses the Supabase secret key for server-side writes.
