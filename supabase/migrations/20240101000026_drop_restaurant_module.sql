-- Drop 14 restaurant module tables — zero code references, zero rows.
-- These are industry-specific tables that don't belong in base ERP.

-- Children first
DROP TABLE IF EXISTS public.recipe_ingredients CASCADE;
DROP TABLE IF EXISTS public.supplier_order_items CASCADE;
DROP TABLE IF EXISTS public.menu_items CASCADE;
DROP TABLE IF EXISTS public.menu_categories CASCADE;
DROP TABLE IF EXISTS public.reservations CASCADE;
DROP TABLE IF EXISTS public.shifts CASCADE;

-- Parents / standalone
DROP TABLE IF EXISTS public.menus CASCADE;
DROP TABLE IF EXISTS public.recipes CASCADE;
DROP TABLE IF EXISTS public.ingredients CASCADE;
DROP TABLE IF EXISTS public.staff_members CASCADE;
DROP TABLE IF EXISTS public.supplier_orders CASCADE;
DROP TABLE IF EXISTS public.restaurant_tables CASCADE;
DROP TABLE IF EXISTS public.waste_entries CASCADE;
DROP TABLE IF EXISTS public.restaurant_capacity CASCADE;
