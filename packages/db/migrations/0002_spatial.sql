-- Spatial schema: the Supabase tables and functions from supabase/migrations
-- (source commit 12ad87b), squashed to their final shape. Differences from the
-- source, all deliberate (plan §8.2, §8.3, §10.3):
--   * user_id columns reference public.users instead of auth.users.
--   * No RLS policies or grants to anon/authenticated/service_role. Tenant
--     isolation is enforced by the API's repositories; the app role gets DML
--     rights through the default privileges set up per database.
--   * scan_export() takes the owner's id and only returns that user's scan,
--     since RLS no longer scopes it.
--   * Indexes added for the catalog list (keyset pagination), the stalled-scan
--     sweep, per-scan child lookups and account-deletion cascades.
-- Column names, types, defaults and nullability are unchanged, so rows copy
-- across from Supabase as they are (plan §18.2).

-- ============================================================================
-- Scans (spaces)
-- ============================================================================
CREATE TABLE public.scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Untitled room',
  notes text,
  status text NOT NULL DEFAULT 'draft',
  width_m numeric,
  length_m numeric,
  height_m numeric,
  floor_area_m2 numeric,
  ai_summary text,
  acoustics jsonb NOT NULL DEFAULT '{}'::jsonb,
  depth_path text,
  depth_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- L2/L5 geometry and site
  site_location geography(Point, 4326),
  site_address text,
  north_offset_deg numeric,
  footprint geometry(Polygon, 0),
  volume_m3 numeric,
  lod_level smallint NOT NULL DEFAULT 0,
  -- Reconstruction output
  dimension_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  scale_reference text,
  depth_provided boolean NOT NULL DEFAULT false,
  analysis_notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  depth_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Provenance and idempotency
  prompt_version text,
  model_version text,
  provider text,
  capture_id uuid
);
CREATE TRIGGER scans_updated_at BEFORE UPDATE ON public.scans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX scans_site_location_gix ON public.scans USING gist (site_location);
CREATE INDEX scans_footprint_gix ON public.scans USING gist (footprint);
-- A retried submit with the same capture_id must not create a second scan.
CREATE UNIQUE INDEX scans_capture_id_user_uniq ON public.scans (user_id, capture_id)
  WHERE capture_id IS NOT NULL;
-- New: the catalog list, newest first, with keyset pagination on (created_at, id).
CREATE INDEX scans_user_created_idx ON public.scans (user_id, created_at DESC, id DESC);
-- New: the stalled-scan sweep only looks at runs in progress.
CREATE INDEX scans_processing_idx ON public.scans (updated_at) WHERE status = 'processing';
-- New: catalog search by name.
CREATE INDEX scans_name_trgm_idx ON public.scans USING gin (name gin_trgm_ops);

-- ============================================================================
-- L0 frames
-- ============================================================================
CREATE TABLE public.scan_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  heading_deg numeric,
  idx integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  pitch_deg numeric,
  camera_pose geometry(PointZ, 0),
  view_cone geometry(Polygon, 0),
  sensor_payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX scan_photos_pose_gix ON public.scan_photos USING gist (camera_pose);
CREATE INDEX scan_photos_scan_idx ON public.scan_photos (scan_id, idx);
CREATE INDEX scan_photos_user_idx ON public.scan_photos (user_id);

-- ============================================================================
-- L3 semantics: objects, surfaces, portals
-- ============================================================================
CREATE TABLE public.scan_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  label text NOT NULL,
  category text,
  confidence numeric,
  x_m numeric,
  y_m numeric,
  width_m numeric,
  depth_m numeric,
  height_m numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  footprint geometry(Polygon, 0),
  centroid geometry(PointZ, 0),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX scan_objects_footprint_gix ON public.scan_objects USING gist (footprint);
CREATE INDEX scan_objects_scan_idx ON public.scan_objects (scan_id);
CREATE INDEX scan_objects_user_idx ON public.scan_objects (user_id);

CREATE TABLE public.scan_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text,
  material text,
  area_m2 numeric,
  absorption numeric,
  reflectivity numeric,
  color_hex text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  plane geometry(Polygon, 0),
  band_absorption jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX scan_surfaces_plane_gix ON public.scan_surfaces USING gist (plane);
CREATE INDEX scan_surfaces_scan_idx ON public.scan_surfaces (scan_id);
CREATE INDEX scan_surfaces_user_idx ON public.scan_surfaces (user_id);

CREATE TABLE public.scan_portals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'door',
  wall text NOT NULL DEFAULT 'north',
  offset_m numeric,
  width_m numeric,
  height_m numeric,
  confidence numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  line geometry(LineString, 0),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  sill_m numeric
);
CREATE INDEX scan_portals_line_gix ON public.scan_portals USING gist (line);
CREATE INDEX scan_portals_scan_idx ON public.scan_portals (scan_id);
CREATE INDEX scan_portals_user_idx ON public.scan_portals (user_id);

-- ============================================================================
-- L0-L5 layer registry and L4 navigation graph. As in the source, user_id on
-- these tables has no foreign key: they are removed with their scan.
-- ============================================================================
CREATE TABLE public.scan_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 5),
  name text NOT NULL,
  producer text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  geom geometry(GeometryCollection, 0),
  quality numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, level, name)
);
CREATE TRIGGER scan_layers_updated_at BEFORE UPDATE ON public.scan_layers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX scan_layers_scan_level_idx ON public.scan_layers (scan_id, level);
CREATE INDEX scan_layers_geom_gix ON public.scan_layers USING gist (geom);

CREATE TABLE public.scan_nav_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'waypoint',
  label text,
  point geometry(PointZ, 0) NOT NULL,
  portal_id uuid REFERENCES public.scan_portals (id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_nav_nodes_point_gix ON public.scan_nav_nodes USING gist (point);
CREATE INDEX scan_nav_nodes_scan_idx ON public.scan_nav_nodes (scan_id);
CREATE INDEX scan_nav_nodes_portal_idx ON public.scan_nav_nodes (portal_id);

CREATE TABLE public.scan_nav_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  from_node uuid NOT NULL REFERENCES public.scan_nav_nodes (id) ON DELETE CASCADE,
  to_node uuid NOT NULL REFERENCES public.scan_nav_nodes (id) ON DELETE CASCADE,
  path geometry(LineStringZ, 0),
  cost_m numeric,
  traversable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_nav_edges_path_gix ON public.scan_nav_edges USING gist (path);
CREATE INDEX scan_nav_edges_scan_idx ON public.scan_nav_edges (scan_id);
CREATE INDEX scan_nav_edges_from_idx ON public.scan_nav_edges (from_node);
CREATE INDEX scan_nav_edges_to_idx ON public.scan_nav_edges (to_node);

-- ============================================================================
-- Analysis runs, feature flags, rate limits, consent
-- ============================================================================
CREATE TABLE public.scan_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.scans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  provider text NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  input_frame_count integer,
  input_token_estimate integer,
  output_token_estimate integer,
  cost_estimate_usd numeric(10, 6),
  error_code text,
  error_message text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scan_analyses_scan_id_idx ON public.scan_analyses (scan_id);
CREATE INDEX scan_analyses_user_id_started_idx ON public.scan_analyses (user_id, started_at DESC);

-- A NULL user_id is the global default; a row with a user_id overrides it.
CREATE TABLE public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  user_id uuid REFERENCES public.users (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flags_key_user_uniq
  ON public.feature_flags (key, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX feature_flags_user_idx ON public.feature_flags (user_id) WHERE user_id IS NOT NULL;

-- Fixed-window counters, one row per (user, bucket). Kept during the move to
-- Redis-backed quotas (plan §11) so both paths can be compared.
CREATE TABLE public.user_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  bucket text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_rate_limits_user_bucket_uniq ON public.user_rate_limits (user_id, bucket);

CREATE TABLE public.capture_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  capture_id uuid NOT NULL,
  consent_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX capture_consents_user_capture_uniq ON public.capture_consents (user_id, capture_id);

-- ============================================================================
-- Product catalog (reference data, no owner) with vector retrieval
-- ============================================================================
CREATE TABLE public.product_dimensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  label text NOT NULL,
  width_m numeric(6, 3),
  height_m numeric(6, 3),
  depth_m numeric(6, 3),
  diagonal_in numeric(6, 2),
  aspect_ratio text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  brand text,
  model text,
  image_url text,
  classification text,
  specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768)
);
CREATE INDEX product_dimensions_category_idx ON public.product_dimensions (category);
CREATE INDEX product_dimensions_embedding_idx
  ON public.product_dimensions USING hnsw (embedding vector_cosine_ops);

-- ============================================================================
-- Functions
-- ============================================================================

-- Top-k semantic catalog match. Rows without an embedding are skipped, so
-- retrieval degrades to "no matches" before the catalog is embedded.
CREATE FUNCTION public.match_product_catalog(
  query_embedding vector(768),
  match_count int DEFAULT 5,
  filter_category text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  category text,
  label text,
  brand text,
  model text,
  classification text,
  image_url text,
  specs jsonb,
  width_m numeric,
  height_m numeric,
  depth_m numeric,
  diagonal_in numeric,
  aspect_ratio text,
  similarity double precision
)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT
    pd.id, pd.category, pd.label, pd.brand, pd.model, pd.classification, pd.image_url,
    pd.specs, pd.width_m, pd.height_m, pd.depth_m, pd.diagonal_in, pd.aspect_ratio,
    1 - (pd.embedding <=> query_embedding) AS similarity
  FROM public.product_dimensions pd
  WHERE pd.embedding IS NOT NULL
    AND (filter_category IS NULL OR pd.category = filter_category)
  ORDER BY pd.embedding <=> query_embedding
  LIMIT greatest(1, match_count);
$$;

-- Atomic fixed-window rate limit: one upsert decides, so concurrent calls for
-- the same (user, bucket) serialize on the row lock.
CREATE FUNCTION public.consume_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_window_ms integer,
  p_max integer
)
RETURNS TABLE (allowed boolean, remaining integer, retry_after_ms bigint)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window interval := make_interval(secs => p_window_ms / 1000.0);
  v_started timestamptz;
  v_count integer;
BEGIN
  INSERT INTO public.user_rate_limits AS r (user_id, bucket, window_started_at, count, updated_at)
  VALUES (p_user_id, p_bucket, v_now, 1, v_now)
  ON CONFLICT (user_id, bucket) DO UPDATE
    SET window_started_at = CASE
          WHEN r.window_started_at + v_window <= v_now THEN v_now
          ELSE r.window_started_at
        END,
        count = CASE
          WHEN r.window_started_at + v_window <= v_now THEN 1
          ELSE r.count + 1
        END,
        updated_at = v_now
  RETURNING r.window_started_at, r.count INTO v_started, v_count;

  allowed := v_count <= p_max;
  remaining := greatest(0, p_max - v_count);
  retry_after_ms := CASE
    WHEN v_count <= p_max THEN 0
    ELSE greatest(0, floor(extract(epoch FROM (v_started + v_window - v_now)) * 1000))::bigint
  END;
  RETURN NEXT;
END;
$$;

-- Everything about one scan as GeoJSON features, WKT rows and the layer
-- bundle. Returns NULL unless the scan exists *and* belongs to _user_id.
CREATE FUNCTION public.scan_export(_scan_id uuid, _user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
WITH s AS (
  SELECT * FROM public.scans WHERE id = _scan_id AND user_id = _user_id
),
feat AS (
  SELECT jsonb_build_object(
    'type','Feature',
    'id','scan:'||s.id,
    'geometry', CASE WHEN s.footprint IS NULL THEN NULL ELSE ST_AsGeoJSON(s.footprint)::jsonb END,
    'properties', jsonb_build_object(
      'layer','L2_geometry','entity','room_footprint','scan_id',s.id,'name',s.name,
      'width_m',s.width_m,'length_m',s.length_m,'height_m',s.height_m,
      'floor_area_m2',s.floor_area_m2,'volume_m3',s.volume_m3,'lod_level',s.lod_level,
      'status',s.status,'created_at',s.created_at)
  ) f FROM s
  UNION ALL
  SELECT jsonb_build_object(
    'type','Feature','id','object:'||o.id,
    'geometry', CASE WHEN o.footprint IS NULL THEN NULL ELSE ST_AsGeoJSON(o.footprint)::jsonb END,
    'properties', jsonb_build_object(
      'layer','L3_semantics','entity','object','id',o.id,'label',o.label,'category',o.category,
      'confidence',o.confidence,'x_m',o.x_m,'y_m',o.y_m,'width_m',o.width_m,'depth_m',o.depth_m,
      'height_m',o.height_m,'centroid', CASE WHEN o.centroid IS NULL THEN NULL ELSE ST_AsGeoJSON(o.centroid)::jsonb END,
      'attributes',o.attributes,'metadata',o.metadata)
  ) FROM public.scan_objects o WHERE o.scan_id = _scan_id
  UNION ALL
  SELECT jsonb_build_object(
    'type','Feature','id','portal:'||p.id,
    'geometry', CASE WHEN p.line IS NULL THEN NULL ELSE ST_AsGeoJSON(p.line)::jsonb END,
    'properties', jsonb_build_object(
      'layer','L3_semantics','entity','portal','id',p.id,'kind',p.kind,'wall',p.wall,
      'offset_m',p.offset_m,'width_m',p.width_m,'height_m',p.height_m,
      'confidence',p.confidence,'notes',p.notes,'attributes',p.attributes)
  ) FROM public.scan_portals p WHERE p.scan_id = _scan_id
  UNION ALL
  SELECT jsonb_build_object(
    'type','Feature','id','surface:'||u.id,
    'geometry', CASE WHEN u.plane IS NULL THEN NULL ELSE ST_AsGeoJSON(u.plane)::jsonb END,
    'properties', jsonb_build_object(
      'layer','L3_semantics','entity','surface','id',u.id,'name',u.name,'kind',u.kind,
      'material',u.material,'area_m2',u.area_m2,'absorption',u.absorption,
      'reflectivity',u.reflectivity,'color_hex',u.color_hex,'notes',u.notes,
      'band_absorption',u.band_absorption)
  ) FROM public.scan_surfaces u WHERE u.scan_id = _scan_id
  UNION ALL
  SELECT jsonb_build_object(
    'type','Feature','id','photo:'||h.id,
    'geometry', CASE WHEN h.camera_pose IS NULL THEN NULL ELSE ST_AsGeoJSON(h.camera_pose)::jsonb END,
    'properties', jsonb_build_object(
      'layer','L0_capture','entity','camera_pose','id',h.id,'idx',h.idx,
      'heading_deg',h.heading_deg,'pitch_deg',h.pitch_deg,'captured_at',h.captured_at,
      'storage_path',h.storage_path,'sensor_payload',h.sensor_payload,
      'view_cone', CASE WHEN h.view_cone IS NULL THEN NULL ELSE ST_AsGeoJSON(h.view_cone)::jsonb END)
  ) FROM public.scan_photos h WHERE h.scan_id = _scan_id
  UNION ALL
  SELECT jsonb_build_object(
    'type','Feature','id','navnode:'||n.id,
    'geometry', ST_AsGeoJSON(n.point)::jsonb,
    'properties', jsonb_build_object(
      'layer','L4_navigation','entity','nav_node','id',n.id,'kind',n.kind,'label',n.label,
      'portal_id',n.portal_id,'metadata',n.metadata)
  ) FROM public.scan_nav_nodes n WHERE n.scan_id = _scan_id
  UNION ALL
  SELECT jsonb_build_object(
    'type','Feature','id','navedge:'||e.id,
    'geometry', CASE WHEN e.path IS NULL THEN NULL ELSE ST_AsGeoJSON(e.path)::jsonb END,
    'properties', jsonb_build_object(
      'layer','L4_navigation','entity','nav_edge','id',e.id,'from_node',e.from_node,
      'to_node',e.to_node,'cost_m',e.cost_m,'traversable',e.traversable)
  ) FROM public.scan_nav_edges e WHERE e.scan_id = _scan_id
),
site AS (
  SELECT jsonb_build_object(
    'type','Feature','id','site:'||s.id,
    'geometry', CASE WHEN s.site_location IS NULL THEN NULL ELSE ST_AsGeoJSON(s.site_location)::jsonb END,
    'properties', jsonb_build_object('layer','L0_capture','entity','site','crs','EPSG:4326',
      'address',s.site_address,'north_offset_deg',s.north_offset_deg)
  ) f FROM s WHERE s.site_location IS NOT NULL
)
SELECT CASE WHEN (SELECT count(*) FROM s) = 0 THEN NULL ELSE jsonb_build_object(
  'geojson', jsonb_build_object(
    'type','FeatureCollection',
    'crs', jsonb_build_object('local','room-centred metric (X east, Y north, Z up)','site','EPSG:4326'),
    'features', COALESCE((SELECT jsonb_agg(f) FROM (SELECT f FROM feat UNION ALL SELECT f FROM site) x), '[]'::jsonb)
  ),
  'postgis', jsonb_build_object(
    'scans', (SELECT jsonb_agg(to_jsonb(s2) - 'footprint' - 'site_location'
        || jsonb_build_object('footprint', ST_AsText(s2.footprint),
                              'site_location', ST_AsText(s2.site_location::geometry)))
      FROM s s2),
    'scan_objects', COALESCE((SELECT jsonb_agg(to_jsonb(o) - 'footprint' - 'centroid'
        || jsonb_build_object('footprint', ST_AsText(o.footprint), 'centroid', ST_AsText(o.centroid)))
      FROM public.scan_objects o WHERE o.scan_id = _scan_id), '[]'::jsonb),
    'scan_portals', COALESCE((SELECT jsonb_agg(to_jsonb(p) - 'line'
        || jsonb_build_object('line', ST_AsText(p.line)))
      FROM public.scan_portals p WHERE p.scan_id = _scan_id), '[]'::jsonb),
    'scan_surfaces', COALESCE((SELECT jsonb_agg(to_jsonb(u) - 'plane'
        || jsonb_build_object('plane', ST_AsText(u.plane)))
      FROM public.scan_surfaces u WHERE u.scan_id = _scan_id), '[]'::jsonb),
    'scan_photos', COALESCE((SELECT jsonb_agg(to_jsonb(h) - 'camera_pose' - 'view_cone'
        || jsonb_build_object('camera_pose', ST_AsText(h.camera_pose), 'view_cone', ST_AsText(h.view_cone)))
      FROM public.scan_photos h WHERE h.scan_id = _scan_id), '[]'::jsonb),
    'scan_nav_nodes', COALESCE((SELECT jsonb_agg(to_jsonb(n) - 'point'
        || jsonb_build_object('point', ST_AsText(n.point)))
      FROM public.scan_nav_nodes n WHERE n.scan_id = _scan_id), '[]'::jsonb),
    'scan_nav_edges', COALESCE((SELECT jsonb_agg(to_jsonb(e) - 'path'
        || jsonb_build_object('path', ST_AsText(e.path)))
      FROM public.scan_nav_edges e WHERE e.scan_id = _scan_id), '[]'::jsonb)
  ),
  'layers', COALESCE((SELECT jsonb_agg(to_jsonb(l) - 'geom'
      || jsonb_build_object('geom', CASE WHEN l.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(l.geom)::jsonb END)
      ORDER BY l.level)
    FROM public.scan_layers l WHERE l.scan_id = _scan_id), '[]'::jsonb)
) END;
$$;

-- Only the application role calls these; nobody else connects.
REVOKE ALL ON FUNCTION public.consume_rate_limit(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scan_export(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(uuid, text, integer, integer) TO app_rw;
GRANT EXECUTE ON FUNCTION public.scan_export(uuid, uuid) TO app_rw;
