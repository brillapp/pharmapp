-- seed.sql
-- 1) Crea los usuarios en Supabase Auth (UI) con emails reales.
-- 2) Sustituye los emails aquí y ejecuta este script.

do $$
declare
  admin_email text := 'admin@ejemplo.com';
  marta_email text := 'marta@ejemplo.com';
  admin_id uuid;
  marta_id uuid;
begin
  select id into admin_id from auth.users where email = admin_email;
  if admin_id is null then
    raise exception 'No existe usuario admin con email % (créalo en Auth primero)', admin_email;
  end if;

  select id into marta_id from auth.users where email = marta_email;
  if marta_id is null then
    raise exception 'No existe usuario marta con email % (créalo en Auth primero)', marta_email;
  end if;

  insert into public.profiles(user_id,email,display_name,zone,roles,updated_at)
  values (admin_id, admin_email, 'Admin', 'general', array['admin','delegado'], now())
  on conflict (user_id) do update
    set email=excluded.email, display_name=excluded.display_name, zone=excluded.zone, roles=excluded.roles, updated_at=now();

  insert into public.profiles(user_id,email,display_name,zone,roles,updated_at)
  values (marta_id, marta_email, 'Marta', 'general', array['delegado'], now())
  on conflict (user_id) do update
    set email=excluded.email, display_name=excluded.display_name, zone=excluded.zone, roles=excluded.roles, updated_at=now();
end $$;
