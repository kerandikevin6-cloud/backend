-- ZenikBinary (nexas-4) and VenoBinary (nexas-5) share this backend.
-- List their domains so the admin shows them on the Domains page and
-- in the deposits site filter.
insert into public.domains (host, label, status) values
  ('zenikbinary.com', 'ZenikBinary', 'live'),
  ('venobinary.com',  'VenoBinary',  'live')
on conflict (host) do update set label = excluded.label, status = 'live';
