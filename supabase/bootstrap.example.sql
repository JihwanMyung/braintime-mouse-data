-- Run schema.sql first. Create/invite lab members through your project's normal
-- Supabase Auth flow, then obtain their UUIDs from Authentication > Users.
-- No password, JWT or service-role key belongs in this SQL file or the frontend.
-- If signed in through the application, create_colony() creates your owner row:
-- select public.create_colony('Braintime Laboratory');

-- Alternative: privileged SQL-editor bootstrap. Replace both UUID placeholders.
-- begin;
-- insert into public.colonies(id,name,created_by)
-- values ('YOUR-COLONY-UUID','Braintime Laboratory','OWNER-AUTH-USER-UUID');
-- insert into public.memberships(colony_id,user_id,role,updated_by)
-- values ('YOUR-COLONY-UUID','OWNER-AUTH-USER-UUID','owner','OWNER-AUTH-USER-UUID');
-- commit;

-- After sign-in, an owner uses set_member_role via the RPC with an existing
-- invited user's Auth UUID. Editors and viewers cannot call it successfully.
-- SELECT public.set_member_role('COLONY-UUID','COLLEAGUE-AUTH-UUID','editor',true);
-- To revoke access while retaining history, set p_active=false. The final active
-- owner cannot be demoted/revoked through this RPC.
