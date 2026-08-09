-- Stripe subscription state + webhook idempotency for the SaaS paywall.
-- Payment provisioning writes capability_grants(source='stripe') (see
-- 20260628140000); this table links a company to its Stripe customer/
-- subscription and tracks status. stripe_webhook_events dedupes retried
-- webhook deliveries.

CREATE TABLE public.company_subscriptions (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id             uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text,        -- Stripe subscription status: active|trialing|past_due|canceled|...
  plan                   text,        -- 'monthly' | 'yearly'
  current_period_end     timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_company_subscriptions_customer ON public.company_subscriptions (stripe_customer_id);
CREATE INDEX idx_company_subscriptions_subscription ON public.company_subscriptions (stripe_subscription_id);

ALTER TABLE public.company_subscriptions ENABLE ROW LEVEL SECURITY;

-- Members may read their company's subscription status (billing page). Writes
-- are service-role only (checkout route + Stripe webhook) — a user can never
-- fabricate a subscription.
CREATE POLICY "members read company_subscriptions"
  ON public.company_subscriptions FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER set_updated_at_company_subscriptions
  BEFORE UPDATE ON public.company_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Webhook idempotency: each processed Stripe event id is logged after handling;
-- duplicate deliveries are skipped. Service-role only (RLS on, no policies).
CREATE TABLE public.stripe_webhook_events (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
