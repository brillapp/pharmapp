-- Supabase schema (Postgres) para Ventas Offline
-- Ejecuta en Supabase SQL Editor.
-- Recomendación: crea primero los usuarios en Authentication > Users:
--   - admin (tu email real)
--   - marta (email real)
-- Luego ejecuta seed.sql para crear perfiles.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  zone text default 'general' not null,
  roles text[] default array['delegado']::text[] not null,
  updated_at timestamptz default now() not null
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles
for select
using (
  auth.uid() = user_id
  or exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and 'admin' = any(p.roles)
  )
);

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin"
on public.profiles
for update
using (
  auth.uid() = user_id
  or exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and 'admin' = any(p.roles)
  )
)
with check (
  auth.uid() = user_id
  or exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and 'admin' = any(p.roles)
  )
);

drop policy if exists "profiles_insert_admin_only" on public.profiles;
create policy "profiles_insert_admin_only"
on public.profiles
for insert
with check (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and 'admin' = any(p.roles)
  )
);

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and 'admin' = any(p.roles)
  );
$$;

create or replace function public.can_access_zone(z text)
returns boolean
language sql
stable
as $$
  select public.is_admin()
     or exists (
        select 1 from public.profiles p
        where p.user_id = auth.uid()
          and p.zone = z
     );
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'farmacias','misFarmacias','opticas','misOpticas','productos','pedidos','visitas','settings','outbox'
  ]
  loop
    execute format('create table if not exists public.%I (
      zone text not null,
      id text not null,
      updated_at timestamptz default now() not null,
      data jsonb not null,
      primary key (zone,id)
    );', t);

    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists "%I_select_zone" on public.%I;', t, t);
    execute format('create policy "%I_select_zone" on public.%I
      for select
      using (public.can_access_zone(zone));', t, t);

    execute format('drop policy if exists "%I_insert_zone" on public.%I;', t, t);
    execute format('create policy "%I_insert_zone" on public.%I
      for insert
      with check (public.can_access_zone(zone));', t, t);

    execute format('drop policy if exists "%I_update_zone" on public.%I;', t, t);
    execute format('create policy "%I_update_zone" on public.%I
      for update
      using (public.can_access_zone(zone))
      with check (public.can_access_zone(zone));', t, t);

    execute format('drop policy if exists "%I_delete_zone" on public.%I;', t, t);
    execute format('create policy "%I_delete_zone" on public.%I
      for delete
      using (public.can_access_zone(zone));', t, t);
  end loop;
end $$;
