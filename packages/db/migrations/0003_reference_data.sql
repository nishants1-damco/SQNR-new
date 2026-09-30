-- Product catalog reference rows, copied verbatim from the source migrations
-- (in order: 20260915120000_phase1_2_3_scaffolding, 20260916100000_indian_
-- product_dimensions_seed, 20260922000000_product_catalog_rag).
--
-- Production cutover (plan §18.2) imports the live product_dimensions table,
-- which already contains these rows plus embeddings and images. The import
-- must replace this table's contents rather than append to them.

-- From 20260915120000_phase1_2_3_scaffolding.sql
insert into public.product_dimensions (category, label, width_m, height_m, depth_m, diagonal_in, aspect_ratio, source) values
  ('tv', '43" TV', 0.955, 0.560, 0.070, 43, '16:9', 'seed:common'),
  ('tv', '50" TV', 1.111, 0.634, 0.070, 50, '16:9', 'seed:common'),
  ('tv', '55" TV', 1.220, 0.700, 0.075, 55, '16:9', 'seed:common'),
  ('tv', '65" TV', 1.445, 0.822, 0.080, 65, '16:9', 'seed:common'),
  ('tv', '75" TV', 1.670, 0.945, 0.085, 75, '16:9', 'seed:common'),
  ('tv', '85" TV', 1.885, 1.075, 0.090, 85, '16:9', 'seed:common'),
  ('door', 'Interior door 32"', 0.813, 2.032, 0.045, null, null, 'seed:ansi'),
  ('door', 'Interior door 36"', 0.914, 2.032, 0.045, null, null, 'seed:ansi'),
  ('outlet', 'US duplex outlet', 0.070, 0.114, 0.040, null, null, 'seed:nema'),
  ('outlet', 'EU Schuko outlet', 0.085, 0.085, 0.050, null, null, 'seed:cee'),
  ('window', 'Standard casement', 0.610, 1.220, 0.150, null, null, 'seed:common'),
  ('window', 'Sliding patio door', 1.830, 2.032, 0.150, null, null, 'seed:common')
on conflict do nothing;

-- From 20260916100000_indian_product_dimensions_seed.sql
insert into public.product_dimensions (category, label, width_m, height_m, depth_m, diagonal_in, aspect_ratio, source) values
  -- Doors (common Indian residential sizes)
  ('door', 'Main door (Indian standard) 3ft x 7ft', 0.900, 2.100, 0.045, null, null, 'seed:common-in'),
  ('door', 'Internal door (Indian standard) 2.5ft x 7ft', 0.750, 2.100, 0.040, null, null, 'seed:common-in'),
  ('door', 'Bathroom door (Indian standard) 2ft x 7ft', 0.600, 2.100, 0.035, null, null, 'seed:common-in'),

  -- Windows (common Indian modular sizes)
  ('window', 'Indian standard window 4ft x 4ft', 1.200, 1.200, 0.100, null, null, 'seed:common-in'),
  ('window', 'Indian standard window 3ft x 4ft', 0.900, 1.200, 0.100, null, null, 'seed:common-in'),
  ('window', 'Indian ventilator window 2ft x 1.5ft', 0.600, 0.450, 0.100, null, null, 'seed:common-in'),

  -- Ceiling fans (sweep size stored like a TV "diagonal", in inches)
  ('fan', 'Ceiling fan 48in sweep', 1.220, 0.300, 1.220, 48, null, 'seed:common-in'),
  ('fan', 'Ceiling fan 36in sweep', 0.900, 0.300, 0.900, 36, null, 'seed:common-in'),

  -- Beds (Indian standard mattress sizes)
  ('bed', 'Single bed (Indian standard) 3ft x 6.25ft', 0.910, 0.450, 1.900, null, null, 'seed:common-in'),
  ('bed', 'Queen bed (Indian standard) 5ft x 6.25ft', 1.520, 0.450, 1.900, null, null, 'seed:common-in'),
  ('bed', 'King bed (Indian standard) 6ft x 6.25ft', 1.830, 0.450, 1.900, null, null, 'seed:common-in'),

  -- Wardrobe / almirah
  ('wardrobe', '2-door wardrobe', 0.900, 2.100, 0.600, null, null, 'seed:common-in'),
  ('wardrobe', '3-door wardrobe', 1.500, 2.100, 0.600, null, null, 'seed:common-in'),

  -- Sofa
  ('sofa', '3-seater sofa', 1.800, 0.850, 0.850, null, null, 'seed:common'),
  ('sofa', '2-seater sofa', 1.500, 0.850, 0.850, null, null, 'seed:common'),

  -- Dining table
  ('dining_table', '6-seater dining table', 1.500, 0.750, 0.900, null, null, 'seed:common'),
  ('dining_table', '4-seater dining table', 1.200, 0.750, 0.750, null, null, 'seed:common'),

  -- Kitchen / laundry appliances
  ('refrigerator', 'Single-door refrigerator', 0.600, 1.500, 0.600, null, null, 'seed:common'),
  ('refrigerator', 'Double-door refrigerator', 0.700, 1.700, 0.700, null, null, 'seed:common'),
  ('washing_machine', 'Front-load washing machine', 0.600, 0.850, 0.600, null, null, 'seed:common'),
  ('washing_machine', 'Top-load washing machine', 0.600, 0.900, 0.600, null, null, 'seed:common'),

  -- Split AC indoor unit (very common in Indian homes)
  ('ac', 'Split AC indoor unit 1.5 ton', 0.900, 0.300, 0.200, null, null, 'seed:common'),

  -- Water heater / geyser (cylindrical; width/depth used as diameter)
  ('geyser', 'Storage water heater 15L', 0.350, 0.550, 0.350, null, null, 'seed:common-in')
on conflict do nothing;

-- From 20260922000000_product_catalog_rag.sql (real-device rows)
insert into public.product_dimensions
  (category, label, brand, model, classification, image_url, specs,
   width_m, height_m, depth_m, diagonal_in, aspect_ratio, source)
values
  (
    'tv',
    'Xiaomi TV X Pro 43 QLED (43-inch 4K QLED television)',
    'Xiaomi',
    'ELA6002IN-L43MB-APIN',
    'television',
    null,
    jsonb_build_object(
      'series', 'X Pro QLED',
      'display_size_in', 43,
      'display_size_cm', 108,
      'panel', 'QLED',
      'resolution', '3840x2160 4K Ultra HD',
      'refresh_rate_hz', 60,
      'hdr', 'Filmmaker Mode, Dolby Vision, HDR10+',
      'audio_power_w', 30,
      'weight_kg', 5.9,
      'launch_year', 2025,
      'dimensions_with_stand_mm', jsonb_build_object('w', 957, 'h', 599, 'd', 211)
    ),
    0.957, 0.599, 0.211, 43, '16:9', 'seed:device:xiaomi-x-pro-43'
  ),
  (
    'monitor',
    'BenQ GW2786TC 27-inch IPS monitor (27-inch FHD computer monitor)',
    'BenQ',
    'GW2786TC',
    'computer monitor',
    null,
    jsonb_build_object(
      'series', '2786',
      'display_size_in', 27,
      'panel', 'IPS LED',
      'finish', 'Matte',
      'resolution', '1920x1080 FHD 1080p',
      'refresh_rate_hz', 100,
      'response_ms', 5,
      'aspect_ratio', '16:9',
      'connectivity', 'DisplayPort, HDMI, USB Type-C',
      'colour', 'White',
      'mounting', 'Wall mount / stand',
      'weight_kg', 7.9,
      'dimensions_with_stand_cm', jsonb_build_object('w', 61.2, 'h', 53.5, 'd', 23.5)
    ),
    0.612, 0.535, 0.235, 27, '16:9', 'seed:device:benq-gw2786tc'
  )
on conflict do nothing;
