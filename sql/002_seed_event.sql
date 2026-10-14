-- Seed event and categories

INSERT INTO event_config (
  id, name, tagline, event_date, registration_deadline, venue_name, venue_city, is_registration_open, created_at, updated_at
) VALUES (
  'sss-2026',
  'Salem Star Speaker — The Speaking Contest',
  'The Speaking Contest',
  '2026-11-01',
  '2026-10-26T23:59:59+05:30',
  'Hotel A Square Rivera',
  'Salem',
  1,
  '2026-10-14 00:00:00',
  '2026-10-14 00:00:00'
);

INSERT INTO categories (slug, name, form_label, min_age, max_age, fee_paise, currency, is_active)
VALUES 
  ('kid', 'Kids', 'Junior (10-13 years)', 10, 13, 9900, 'INR', 1),
  ('teen', 'Teens', 'Teens (14-17 years)', 14, 17, 19900, 'INR', 1),
  ('adult', 'Adults', 'Adults (18+)', 18, 99, 29900, 'INR', 1);
