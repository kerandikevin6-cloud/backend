-- ZenikBinary (nexas-4), VenoBinary (nexas-5) and ZaviBinary (nexas-6)
-- share this backend. List their domains so the admin shows them on the
-- Domains page and in the deposits site filter. Safe to run more than once.
insert into public.domains (host, label, status) values
  ('zenikbinary.com', 'ZenikBinary', 'live'),
  ('venobinary.com',  'VenoBinary',  'live'),
  ('zavibinary.com',  'ZaviBinary',  'live')
on conflict (host) do update set label = excluded.label, status = 'live';
