-- LenoBinary (nexas-10) and RivonBinary (nexas-11) share this backend.
-- A live domain here is also an allowed CORS origin, and the admin shows
-- it on the Domains page and in the deposits site filter. Safe to rerun.
insert into public.domains (host, label, status) values
  ('lenobinary.com', 'LenoBinary', 'live'),
  ('rivonbinary.com', 'RivonBinary', 'live')
on conflict (host) do update set label = excluded.label, status = 'live';
