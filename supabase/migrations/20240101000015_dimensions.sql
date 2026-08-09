-- Migration 15: Dimensions
-- Cost centers (kostnadsställen) and projects for journal entry lines

-- =============================================================================
-- 1. cost_centers table
-- =============================================================================
CREATE TABLE public.cost_centers (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  code       text NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, code)
);

ALTER TABLE public.cost_centers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cost_centers_select" ON public.cost_centers
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "cost_centers_insert" ON public.cost_centers
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "cost_centers_update" ON public.cost_centers
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "cost_centers_delete" ON public.cost_centers
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_cost_centers_user_id ON public.cost_centers (user_id);

CREATE TRIGGER cost_centers_updated_at
  BEFORE UPDATE ON public.cost_centers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. projects table
-- =============================================================================
CREATE TABLE public.projects (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  code       text NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  start_date date,
  end_date   date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, code)
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "projects_select" ON public.projects
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "projects_insert" ON public.projects
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "projects_delete" ON public.projects
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_projects_user_id ON public.projects (user_id);

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
