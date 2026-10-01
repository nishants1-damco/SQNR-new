-- The Supabase project's schema, as the Lovable repo's 16 migrations leave
-- it (supabase/migrations up to 20260924000000_atomic_rate_limit.sql), plus
-- minimal stand-ins for what Supabase itself provides (auth.users,
-- storage.objects, auth.uid(), the anon/authenticated/service_role roles).
-- Used by the integration test as the migration's source. Regenerate it if
-- the Supabase schema changes before cutover:
--   1. create an empty database and run supabase-stubs.sql in it;
--   2. apply the Lovable repo's supabase/migrations/*.sql in order;
--   3. pg_dump --schema-only --no-owner --no-privileges --no-comments
--        -n public -n auth -n storage <db>
--   4. keep this header, then paste the dump from after its `SET row_security`
--      line, minus `CREATE SCHEMA public;`.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
-- As pg_dump sets it: function bodies may refer to tables created later.
SET check_function_bodies = false;
SET client_min_messages = warning;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

--
-- Name: storage; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA storage;

--
-- Name: role(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;

--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

--
-- Name: consume_rate_limit(uuid, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_rate_limit(p_user_id uuid, p_bucket text, p_window_ms integer, p_max integer) RETURNS TABLE(allowed boolean, remaining integer, retry_after_ms bigint)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval := make_interval(secs => p_window_ms / 1000.0);
  v_started timestamptz;
  v_count integer;
begin
  insert into public.user_rate_limits as r (user_id, bucket, window_started_at, count, updated_at)
  values (p_user_id, p_bucket, v_now, 1, v_now)
  on conflict (user_id, bucket) do update
    set window_started_at = case
          when r.window_started_at + v_window <= v_now then v_now
          else r.window_started_at
        end,
        count = case
          when r.window_started_at + v_window <= v_now then 1
          else r.count + 1
        end,
        updated_at = v_now
  returning r.window_started_at, r.count into v_started, v_count;

  allowed := v_count <= p_max;
  remaining := greatest(0, p_max - v_count);
  retry_after_ms := case
    when v_count <= p_max then 0
    else greatest(0, floor(extract(epoch from (v_started + v_window - v_now)) * 1000))::bigint
  end;
  return next;
end;
$$;

--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

--
-- Name: match_product_catalog(public.vector, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_product_catalog(query_embedding public.vector, match_count integer DEFAULT 5, filter_category text DEFAULT NULL::text) RETURNS TABLE(id uuid, category text, label text, brand text, model text, classification text, image_url text, specs jsonb, width_m numeric, height_m numeric, depth_m numeric, diagonal_in numeric, aspect_ratio text, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  select
    pd.id,
    pd.category,
    pd.label,
    pd.brand,
    pd.model,
    pd.classification,
    pd.image_url,
    pd.specs,
    pd.width_m,
    pd.height_m,
    pd.depth_m,
    pd.diagonal_in,
    pd.aspect_ratio,
    1 - (pd.embedding <=> query_embedding) as similarity
  from public.product_dimensions pd
  where pd.embedding is not null
    and (filter_category is null or pd.category = filter_category)
  order by pd.embedding <=> query_embedding
  limit greatest(1, match_count);
$$;

--
-- Name: scan_export(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.scan_export(_scan_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
WITH s AS (
  SELECT * FROM public.scans WHERE id = _scan_id
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

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

--
-- Name: foldername(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: identities; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    provider text NOT NULL,
    provider_id text NOT NULL,
    identity_data jsonb,
    email text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    instance_id uuid,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    aud character varying(255),
    role character varying(255),
    email character varying(255),
    encrypted_password character varying(255),
    email_confirmed_at timestamp with time zone,
    last_sign_in_at timestamp with time zone,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    banned_until timestamp with time zone,
    deleted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL
);

--
-- Name: capture_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capture_consents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    consent_version text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    user_id uuid,
    enabled boolean DEFAULT false NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: product_dimensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_dimensions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category text NOT NULL,
    label text NOT NULL,
    width_m numeric(6,3),
    height_m numeric(6,3),
    depth_m numeric(6,3),
    diagonal_in numeric(6,2),
    aspect_ratio text,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    brand text,
    model text,
    image_url text,
    classification text,
    specs jsonb DEFAULT '{}'::jsonb NOT NULL,
    embedding public.vector(768)
);

--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: scan_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_analyses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    model_version text NOT NULL,
    prompt_version text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    duration_ms integer,
    input_frame_count integer,
    input_token_estimate integer,
    output_token_estimate integer,
    cost_estimate_usd numeric(10,6),
    error_code text,
    error_message text,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scan_analyses_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text, 'timed_out'::text])))
);

--
-- Name: scan_layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_layers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    level smallint NOT NULL,
    name text NOT NULL,
    producer text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    geom public.geometry(GeometryCollection),
    quality numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scan_layers_level_check CHECK (((level >= 0) AND (level <= 5)))
);

--
-- Name: scan_nav_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_nav_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    from_node uuid NOT NULL,
    to_node uuid NOT NULL,
    path public.geometry(LineStringZ),
    cost_m numeric,
    traversable boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: scan_nav_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_nav_nodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text DEFAULT 'waypoint'::text NOT NULL,
    label text,
    point public.geometry(PointZ) NOT NULL,
    portal_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: scan_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    label text NOT NULL,
    category text,
    confidence numeric,
    x_m numeric,
    y_m numeric,
    width_m numeric,
    depth_m numeric,
    height_m numeric,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    footprint public.geometry(Polygon),
    centroid public.geometry(PointZ),
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: scan_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    storage_path text NOT NULL,
    heading_deg numeric,
    idx integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    pitch_deg numeric,
    camera_pose public.geometry(PointZ),
    view_cone public.geometry(Polygon),
    sensor_payload jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: scan_portals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_portals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text DEFAULT 'door'::text NOT NULL,
    wall text DEFAULT 'north'::text NOT NULL,
    offset_m numeric,
    width_m numeric,
    height_m numeric,
    confidence numeric,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    line public.geometry(LineString),
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    sill_m numeric
);

--
-- Name: scan_surfaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_surfaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    kind text,
    material text,
    area_m2 numeric,
    absorption numeric,
    reflectivity numeric,
    color_hex text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    plane public.geometry(Polygon),
    band_absorption jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text DEFAULT 'Untitled room'::text NOT NULL,
    notes text,
    status text DEFAULT 'draft'::text NOT NULL,
    width_m numeric,
    length_m numeric,
    height_m numeric,
    floor_area_m2 numeric,
    ai_summary text,
    acoustics jsonb DEFAULT '{}'::jsonb NOT NULL,
    depth_path text,
    depth_source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    site_location public.geography(Point,4326),
    site_address text,
    north_offset_deg numeric,
    footprint public.geometry(Polygon),
    volume_m3 numeric,
    lod_level smallint DEFAULT 0 NOT NULL,
    dimension_confidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    scale_reference text,
    depth_provided boolean DEFAULT false NOT NULL,
    analysis_notes jsonb DEFAULT '{}'::jsonb NOT NULL,
    depth_metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    prompt_version text,
    model_version text,
    provider text,
    capture_id uuid
);

--
-- Name: user_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    bucket text NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: buckets; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text NOT NULL,
    owner uuid,
    public boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: objects; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_id text,
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_accessed_at timestamp with time zone DEFAULT now()
);

--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: capture_consents capture_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capture_consents
    ADD CONSTRAINT capture_consents_pkey PRIMARY KEY (id);

--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);

--
-- Name: product_dimensions product_dimensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_dimensions
    ADD CONSTRAINT product_dimensions_pkey PRIMARY KEY (id);

--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

--
-- Name: scan_analyses scan_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_analyses
    ADD CONSTRAINT scan_analyses_pkey PRIMARY KEY (id);

--
-- Name: scan_layers scan_layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_layers
    ADD CONSTRAINT scan_layers_pkey PRIMARY KEY (id);

--
-- Name: scan_layers scan_layers_scan_id_level_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_layers
    ADD CONSTRAINT scan_layers_scan_id_level_name_key UNIQUE (scan_id, level, name);

--
-- Name: scan_nav_edges scan_nav_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_nav_edges
    ADD CONSTRAINT scan_nav_edges_pkey PRIMARY KEY (id);

--
-- Name: scan_nav_nodes scan_nav_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_nav_nodes
    ADD CONSTRAINT scan_nav_nodes_pkey PRIMARY KEY (id);

--
-- Name: scan_objects scan_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_objects
    ADD CONSTRAINT scan_objects_pkey PRIMARY KEY (id);

--
-- Name: scan_photos scan_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_photos
    ADD CONSTRAINT scan_photos_pkey PRIMARY KEY (id);

--
-- Name: scan_portals scan_portals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_portals
    ADD CONSTRAINT scan_portals_pkey PRIMARY KEY (id);

--
-- Name: scan_surfaces scan_surfaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_surfaces
    ADD CONSTRAINT scan_surfaces_pkey PRIMARY KEY (id);

--
-- Name: scans scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scans
    ADD CONSTRAINT scans_pkey PRIMARY KEY (id);

--
-- Name: user_rate_limits user_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_rate_limits
    ADD CONSTRAINT user_rate_limits_pkey PRIMARY KEY (id);

--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);

--
-- Name: objects objects_bucket_id_name_key; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_bucket_id_name_key UNIQUE (bucket_id, name);

--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);

--
-- Name: capture_consents_user_capture_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX capture_consents_user_capture_uniq ON public.capture_consents USING btree (user_id, capture_id);

--
-- Name: feature_flags_key_user_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feature_flags_key_user_uniq ON public.feature_flags USING btree (key, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

--
-- Name: product_dimensions_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_dimensions_category_idx ON public.product_dimensions USING btree (category);

--
-- Name: product_dimensions_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_dimensions_embedding_idx ON public.product_dimensions USING hnsw (embedding public.vector_cosine_ops);

--
-- Name: scan_analyses_scan_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_analyses_scan_id_idx ON public.scan_analyses USING btree (scan_id);

--
-- Name: scan_analyses_user_id_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_analyses_user_id_started_idx ON public.scan_analyses USING btree (user_id, started_at DESC);

--
-- Name: scan_layers_geom_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_layers_geom_gix ON public.scan_layers USING gist (geom);

--
-- Name: scan_layers_scan_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_layers_scan_level_idx ON public.scan_layers USING btree (scan_id, level);

--
-- Name: scan_nav_edges_path_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_nav_edges_path_gix ON public.scan_nav_edges USING gist (path);

--
-- Name: scan_nav_nodes_point_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_nav_nodes_point_gix ON public.scan_nav_nodes USING gist (point);

--
-- Name: scan_objects_footprint_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_objects_footprint_gix ON public.scan_objects USING gist (footprint);

--
-- Name: scan_photos_pose_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_photos_pose_gix ON public.scan_photos USING gist (camera_pose);

--
-- Name: scan_portals_line_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_portals_line_gix ON public.scan_portals USING gist (line);

--
-- Name: scan_surfaces_plane_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_surfaces_plane_gix ON public.scan_surfaces USING gist (plane);

--
-- Name: scans_capture_id_user_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scans_capture_id_user_uniq ON public.scans USING btree (user_id, capture_id) WHERE (capture_id IS NOT NULL);

--
-- Name: scans_footprint_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scans_footprint_gix ON public.scans USING gist (footprint);

--
-- Name: scans_site_location_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scans_site_location_gix ON public.scans USING gist (site_location);

--
-- Name: user_rate_limits_user_bucket_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_rate_limits_user_bucket_uniq ON public.user_rate_limits USING btree (user_id, bucket);

--
-- Name: users on_auth_user_created; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

--
-- Name: scan_layers scan_layers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scan_layers_updated_at BEFORE UPDATE ON public.scan_layers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: scans scans_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scans_updated_at BEFORE UPDATE ON public.scans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: identities identities_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: capture_consents capture_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capture_consents
    ADD CONSTRAINT capture_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: feature_flags feature_flags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: scan_analyses scan_analyses_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_analyses
    ADD CONSTRAINT scan_analyses_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_analyses scan_analyses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_analyses
    ADD CONSTRAINT scan_analyses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: scan_layers scan_layers_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_layers
    ADD CONSTRAINT scan_layers_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_nav_edges scan_nav_edges_from_node_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_nav_edges
    ADD CONSTRAINT scan_nav_edges_from_node_fkey FOREIGN KEY (from_node) REFERENCES public.scan_nav_nodes(id) ON DELETE CASCADE;

--
-- Name: scan_nav_edges scan_nav_edges_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_nav_edges
    ADD CONSTRAINT scan_nav_edges_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_nav_edges scan_nav_edges_to_node_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_nav_edges
    ADD CONSTRAINT scan_nav_edges_to_node_fkey FOREIGN KEY (to_node) REFERENCES public.scan_nav_nodes(id) ON DELETE CASCADE;

--
-- Name: scan_nav_nodes scan_nav_nodes_portal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_nav_nodes
    ADD CONSTRAINT scan_nav_nodes_portal_id_fkey FOREIGN KEY (portal_id) REFERENCES public.scan_portals(id) ON DELETE SET NULL;

--
-- Name: scan_nav_nodes scan_nav_nodes_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_nav_nodes
    ADD CONSTRAINT scan_nav_nodes_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_objects scan_objects_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_objects
    ADD CONSTRAINT scan_objects_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_objects scan_objects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_objects
    ADD CONSTRAINT scan_objects_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: scan_photos scan_photos_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_photos
    ADD CONSTRAINT scan_photos_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_photos scan_photos_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_photos
    ADD CONSTRAINT scan_photos_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: scan_portals scan_portals_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_portals
    ADD CONSTRAINT scan_portals_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_portals scan_portals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_portals
    ADD CONSTRAINT scan_portals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: scan_surfaces scan_surfaces_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_surfaces
    ADD CONSTRAINT scan_surfaces_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

--
-- Name: scan_surfaces scan_surfaces_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_surfaces
    ADD CONSTRAINT scan_surfaces_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: scans scans_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scans
    ADD CONSTRAINT scans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: user_rate_limits user_rate_limits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_rate_limits
    ADD CONSTRAINT user_rate_limits_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: objects objects_bucket_id_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);

--
-- Name: scan_nav_edges Users manage their own nav edges; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own nav edges" ON public.scan_nav_edges TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: scan_nav_nodes Users manage their own nav nodes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own nav nodes" ON public.scan_nav_nodes TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: scan_layers Users manage their own scan layers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own scan layers" ON public.scan_layers TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: capture_consents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capture_consents ENABLE ROW LEVEL SECURITY;

--
-- Name: capture_consents capture_consents insert own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "capture_consents insert own" ON public.capture_consents FOR INSERT WITH CHECK ((auth.uid() = user_id));

--
-- Name: capture_consents capture_consents select own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "capture_consents select own" ON public.capture_consents FOR SELECT USING ((auth.uid() = user_id));

--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags feature_flags select all authed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "feature_flags select all authed" ON public.feature_flags FOR SELECT TO authenticated USING (true);

--
-- Name: scan_objects own objects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own objects" ON public.scan_objects TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: scan_photos own photos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own photos" ON public.scan_photos TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: scan_portals own portals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own portals" ON public.scan_portals TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: profiles own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own profile" ON public.profiles TO authenticated USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));

--
-- Name: scans own scans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own scans" ON public.scans TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: scan_surfaces own surfaces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own surfaces" ON public.scan_surfaces TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: product_dimensions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_dimensions ENABLE ROW LEVEL SECURITY;

--
-- Name: product_dimensions product_dimensions select all authed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "product_dimensions select all authed" ON public.product_dimensions FOR SELECT TO authenticated USING (true);

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_analyses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_analyses ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_analyses scan_analyses insert own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "scan_analyses insert own" ON public.scan_analyses FOR INSERT WITH CHECK ((auth.uid() = user_id));

--
-- Name: scan_analyses scan_analyses select own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "scan_analyses select own" ON public.scan_analyses FOR SELECT USING ((auth.uid() = user_id));

--
-- Name: scan_analyses scan_analyses update own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "scan_analyses update own" ON public.scan_analyses FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

--
-- Name: scan_layers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_layers ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_nav_edges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_nav_edges ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_nav_nodes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_nav_nodes ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_objects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_objects ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_portals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_portals ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_surfaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_surfaces ENABLE ROW LEVEL SECURITY;

--
-- Name: scans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scans ENABLE ROW LEVEL SECURITY;

--
-- Name: user_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: user_rate_limits user_rate_limits select own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "user_rate_limits select own" ON public.user_rate_limits FOR SELECT USING ((auth.uid() = user_id));

--
-- Name: objects; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

--
-- Name: objects own scan files delete; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "own scan files delete" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'scans'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));

--
-- Name: objects own scan files read; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "own scan files read" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'scans'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));

--
-- Name: objects own scan files update; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "own scan files update" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'scans'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));

--
-- Name: objects own scan files write; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "own scan files write" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'scans'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));

--
-- PostgreSQL database dump complete
--

