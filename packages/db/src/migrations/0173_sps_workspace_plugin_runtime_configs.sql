CREATE TABLE "sps_workspace_plugin_runtime_configs" (
	"workspace_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sps_workspace_plugin_runtime_configs_workspace_id_plugin_id_pk" PRIMARY KEY("workspace_id","plugin_id")
);
--> statement-breakpoint
ALTER TABLE "sps_workspace_plugin_runtime_configs" ADD CONSTRAINT "sps_workspace_plugin_runtime_configs_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_workspace_plugin_runtime_configs" ADD CONSTRAINT "sps_workspace_plugin_runtime_configs_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_workspace_plugin_runtime_config_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.revision := gen_random_uuid();
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sps_workspace_plugin_runtime_config_revision
BEFORE UPDATE ON public.sps_workspace_plugin_runtime_configs
FOR EACH ROW EXECUTE FUNCTION public.sps_workspace_plugin_runtime_config_before_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sps_workspace_plugin_runtime_config_authority_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sps_workspace_plugin_authority_bump(NEW.workspace_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.sps_workspace_plugin_authority_bump(OLD.workspace_id);
  ELSIF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    IF OLD.workspace_id < NEW.workspace_id THEN
      PERFORM public.sps_workspace_plugin_authority_bump(OLD.workspace_id);
      PERFORM public.sps_workspace_plugin_authority_bump(NEW.workspace_id);
    ELSE
      PERFORM public.sps_workspace_plugin_authority_bump(NEW.workspace_id);
      PERFORM public.sps_workspace_plugin_authority_bump(OLD.workspace_id);
    END IF;
  ELSE
    PERFORM public.sps_workspace_plugin_authority_bump(NEW.workspace_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sps_workspace_plugin_runtime_config_authority_revision
AFTER INSERT OR UPDATE OR DELETE ON public.sps_workspace_plugin_runtime_configs
FOR EACH ROW EXECUTE FUNCTION public.sps_workspace_plugin_runtime_config_authority_changed();
--> statement-breakpoint
CREATE TRIGGER sps_workspace_plugin_runtime_config_authority_truncate_revision
AFTER TRUNCATE ON public.sps_workspace_plugin_runtime_configs
FOR EACH STATEMENT EXECUTE FUNCTION public.sps_plugin_authority_truncate_changed();
