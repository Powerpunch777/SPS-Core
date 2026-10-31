CREATE TABLE "sps_plugin_authority_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_workspace_plugin_authority" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL
);
--> statement-breakpoint
-- Drizzle models these revision tables. PostgreSQL triggers keep every relevant
-- catalog or Workspace policy mutation durable, including delete/recreate ABA.
INSERT INTO public.sps_plugin_authority_catalog (id, revision)
VALUES ('runtime', gen_random_uuid())
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO public.sps_workspace_plugin_authority (workspace_id, revision)
SELECT id, gen_random_uuid() FROM public.companies
ON CONFLICT (workspace_id) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_plugin_authority_bump_catalog()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.sps_plugin_authority_catalog (id, revision)
  VALUES ('runtime', gen_random_uuid())
  ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_workspace_plugin_authority_bump(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.sps_workspace_plugin_authority (workspace_id, revision)
  VALUES (p_workspace_id, gen_random_uuid())
  ON CONFLICT (workspace_id) DO UPDATE SET revision = EXCLUDED.revision;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_plugin_authority_catalog_row_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.sps_plugin_authority_bump_catalog();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sps_plugins_authority_catalog_revision
AFTER INSERT OR UPDATE OR DELETE ON public.plugins
FOR EACH ROW EXECUTE FUNCTION public.sps_plugin_authority_catalog_row_changed();
--> statement-breakpoint
CREATE TRIGGER sps_plugin_config_authority_catalog_revision
AFTER INSERT OR UPDATE OR DELETE ON public.plugin_config
FOR EACH ROW EXECUTE FUNCTION public.sps_plugin_authority_catalog_row_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_plugin_authority_workspace_settings_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sps_workspace_plugin_authority_bump(NEW.company_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.sps_workspace_plugin_authority_bump(OLD.company_id);
  ELSIF OLD.company_id IS DISTINCT FROM NEW.company_id THEN
    IF OLD.company_id < NEW.company_id THEN
      PERFORM public.sps_workspace_plugin_authority_bump(OLD.company_id);
      PERFORM public.sps_workspace_plugin_authority_bump(NEW.company_id);
    ELSE
      PERFORM public.sps_workspace_plugin_authority_bump(NEW.company_id);
      PERFORM public.sps_workspace_plugin_authority_bump(OLD.company_id);
    END IF;
  ELSE
    PERFORM public.sps_workspace_plugin_authority_bump(NEW.company_id);
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sps_plugin_company_settings_workspace_revision
AFTER INSERT OR UPDATE OR DELETE ON public.plugin_company_settings
FOR EACH ROW EXECUTE FUNCTION public.sps_plugin_authority_workspace_settings_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_plugin_authority_workspace_company_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sps_workspace_plugin_authority_bump(NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.sps_workspace_plugin_authority_bump(OLD.id);
  ELSIF OLD.id IS DISTINCT FROM NEW.id THEN
    IF OLD.id < NEW.id THEN
      PERFORM public.sps_workspace_plugin_authority_bump(OLD.id);
      PERFORM public.sps_workspace_plugin_authority_bump(NEW.id);
    ELSE
      PERFORM public.sps_workspace_plugin_authority_bump(NEW.id);
      PERFORM public.sps_workspace_plugin_authority_bump(OLD.id);
    END IF;
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.sps_workspace_plugin_authority_bump(NEW.id);
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sps_companies_workspace_plugin_authority_revision
AFTER INSERT OR UPDATE OR DELETE ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.sps_plugin_authority_workspace_company_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_plugin_authority_truncate_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.sps_plugin_authority_bump_catalog();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sps_plugins_authority_catalog_truncate_revision
AFTER TRUNCATE ON public.plugins
FOR EACH STATEMENT EXECUTE FUNCTION public.sps_plugin_authority_truncate_changed();
--> statement-breakpoint
CREATE TRIGGER sps_plugin_config_authority_catalog_truncate_revision
AFTER TRUNCATE ON public.plugin_config
FOR EACH STATEMENT EXECUTE FUNCTION public.sps_plugin_authority_truncate_changed();
--> statement-breakpoint
CREATE TRIGGER sps_plugin_company_settings_authority_catalog_truncate_revision
AFTER TRUNCATE ON public.plugin_company_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.sps_plugin_authority_truncate_changed();
--> statement-breakpoint
CREATE TRIGGER sps_companies_authority_catalog_truncate_revision
AFTER TRUNCATE ON public.companies
FOR EACH STATEMENT EXECUTE FUNCTION public.sps_plugin_authority_truncate_changed();
