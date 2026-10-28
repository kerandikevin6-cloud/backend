-- ZovianBinary (nexas-3) shares this backend. List its domain so the
-- admin shows it on the Domains page and in the deposits site filter.
insert into public.domains (host, label, status)
values ('zovianbinary.com', 'ZovianBinary', 'live')
on conflict (host) do update set label = excluded.label, status = 'live';
