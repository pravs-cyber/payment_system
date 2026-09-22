-- bdaystudio initial schema
create extension if not exists pgcrypto;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text,
  customer_email text not null,
  country text,
  theme_id text not null,
  package_id text not null,
  deployment_plan text,
  addons jsonb not null default '[]'::jsonb,
  total_usd numeric(10,2) not null check (total_usd >= 0),
  total_inr numeric(12,2),
  status text not null default 'awaiting_payment',
  payment_status text not null default 'unpaid',
  payment_provider text,
  payment_provider_order_id text,
  vercel_url text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists orders_email_idx on public.orders(customer_email);
create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_payment_provider_id_idx
  on public.orders(payment_provider_order_id);

-- Customer-uploaded media belongs to an order.
create table if not exists public.order_media (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  storage_path text not null,
  original_name text,
  media_type text,
  created_at timestamptz not null default now()
);

-- Keep the bucket private. Files should be served through authenticated/server-controlled access.
insert into storage.buckets (id, name, public)
values ('order-media', 'order-media', false)
on conflict (id) do nothing;

alter table public.orders enable row level security;
alter table public.order_media enable row level security;

-- Public storefront does not get direct write access to orders.
-- Server routes use the Supabase secret key and perform privileged writes.
-- Add customer-specific policies after Supabase Auth is enabled.
