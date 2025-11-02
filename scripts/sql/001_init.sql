DO $$
-- Create missing "allow all" policies for a list of tables.
-- This is idempotent: existing policies are skipped.
DECLARE
  tbl text;
  policy_name text;
  missing_policy text;
  tables text[] := ARRAY[
    'calls',
    'call_messages',
    'call_events',
    'callers',
    'call_summaries'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    policy_name := 'srv_all_' || replace(tbl, '-', '_'); -- defensive: replace hyphens

    -- Only proceed if the table exists in the public schema
    IF to_regclass('public.' || tbl) IS NOT NULL THEN

      -- Check existence in pg_policies for schema 'public'
      IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = tbl
          AND policyname = policy_name
      ) THEN
        missing_policy := format(
          'CREATE POLICY %I ON public.%I FOR ALL USING (true) WITH CHECK (true);',
          policy_name, tbl
        );
        EXECUTE missing_policy;
      END IF;

    ELSE
      -- table missing: skip (no action)
      RAISE NOTICE 'Skipping %, table public.% does not exist', tbl, tbl;
    END IF;

  END LOOP;
END;
$$ LANGUAGE plpgsql;