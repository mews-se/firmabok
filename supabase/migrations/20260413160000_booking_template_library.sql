-- =============================================================================
-- Booking Template Library
-- =============================================================================
--
-- Reusable journal entry templates (bokföringsmallar) for common scenarios
-- like EU reverse charge purchases, tax account bookings, private transfers.
--
-- Three scoping levels:
--   1. System templates (company_id IS NULL, team_id IS NULL, is_system = TRUE)
--      Pre-seeded, visible to all authenticated users. Read-only.
--   2. Team templates (company_id IS NULL, team_id IS NOT NULL)
--      Shared across all companies in a team. Created by team admins.
--   3. Company templates (company_id IS NOT NULL)
--      Private to one company. Created by any non-viewer member.
--
-- Template lines use the same ratio-based pattern as categorization_templates
-- line_pattern: user enters total amount, system calculates each line.

CREATE TABLE public.booking_template_library (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  team_id         UUID REFERENCES public.teams(id) ON DELETE CASCADE,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Template identity
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN (
                      'eu_trade', 'tax_account', 'private_transfer',
                      'salary', 'representation', 'year_end',
                      'vat', 'financial', 'other'
                    )),
  entity_type     TEXT NOT NULL DEFAULT 'all'
                    CHECK (entity_type IN ('all', 'enskild_firma', 'aktiebolag')),

  -- Template lines (ratio-based pattern)
  -- Array of: { account, label, side, type, ratio?, vat_rate? }
  lines           JSONB NOT NULL DEFAULT '[]',

  -- Flags
  is_system       BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,

  -- Metadata
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Constraints
  -- System templates: no company, no team
  CHECK (NOT is_system OR (company_id IS NULL AND team_id IS NULL)),
  -- Team templates: no company
  CHECK (team_id IS NULL OR company_id IS NULL),
  -- Company or team or system — at least one scope
  CHECK (company_id IS NOT NULL OR team_id IS NOT NULL OR is_system)
);

-- RLS
ALTER TABLE public.booking_template_library ENABLE ROW LEVEL SECURITY;

-- SELECT: system templates + own company + own team templates
CREATE POLICY "btl_select" ON public.booking_template_library
  FOR SELECT USING (
    is_system
    OR company_id IN (SELECT public.user_company_ids())
    OR team_id IN (SELECT public.user_team_ids())
  );

-- INSERT: company templates or team templates (viewer check enforced in API)
CREATE POLICY "btl_insert" ON public.booking_template_library
  FOR INSERT WITH CHECK (
    NOT is_system
    AND (
      company_id IN (SELECT public.user_company_ids())
      OR (company_id IS NULL AND team_id IN (SELECT public.user_team_ids()))
    )
  );

-- UPDATE: own company or own team templates, never system
CREATE POLICY "btl_update" ON public.booking_template_library
  FOR UPDATE USING (
    NOT is_system
    AND (
      company_id IN (SELECT public.user_company_ids())
      OR (company_id IS NULL AND team_id IN (SELECT public.user_team_ids()))
    )
  );

-- DELETE: own company or own team templates, never system
CREATE POLICY "btl_delete" ON public.booking_template_library
  FOR DELETE USING (
    NOT is_system
    AND (
      company_id IN (SELECT public.user_company_ids())
      OR (company_id IS NULL AND team_id IN (SELECT public.user_team_ids()))
    )
  );

-- Indexes
CREATE INDEX idx_btl_company ON public.booking_template_library (company_id)
  WHERE company_id IS NOT NULL;
CREATE INDEX idx_btl_team ON public.booking_template_library (team_id)
  WHERE team_id IS NOT NULL;
CREATE INDEX idx_btl_system ON public.booking_template_library (is_system)
  WHERE is_system = TRUE;
CREATE INDEX idx_btl_category ON public.booking_template_library (category);
CREATE INDEX idx_btl_active ON public.booking_template_library (is_active)
  WHERE is_active = TRUE;

-- updated_at trigger
CREATE TRIGGER btl_updated_at
  BEFORE UPDATE ON public.booking_template_library
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- Seed system templates
-- =============================================================================
-- Lines format: [{ account, label, side, type, ratio?, vat_rate? }]
-- type: 'business' (main account), 'vat' (VAT line), 'settlement' (bank/cash)
-- ratio: proportion of total amount (business lines should sum to 1.0)
-- vat_rate: decimal (0.25, 0.12, 0.06) — applied via rate/(1+rate) for inclusive

-- EU TRADE
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Inköp EU-varor, omvänd moms 25%',
  'Köp av varor från annat EU-land. Omvänd skattskyldighet — du redovisar både utgående och ingående moms.',
  'eu_trade', 'all', TRUE,
  '[
    {"account": "4010", "label": "Varuinköp", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "2614", "label": "Utgående moms omvänd skattskyldighet 25%", "side": "credit", "type": "vat", "vat_rate": 0.25},
    {"account": "2645", "label": "Beräknad ingående moms 25%", "side": "debit", "type": "vat", "vat_rate": 0.25},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Inköp EU-tjänster, omvänd moms 25%',
  'Köp av tjänster från annat EU-land. Omvänd skattskyldighet — du redovisar både utgående och ingående moms.',
  'eu_trade', 'all', TRUE,
  '[
    {"account": "6540", "label": "IT-tjänster", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "2614", "label": "Utgående moms omvänd skattskyldighet 25%", "side": "credit", "type": "vat", "vat_rate": 0.25},
    {"account": "2645", "label": "Beräknad ingående moms 25%", "side": "debit", "type": "vat", "vat_rate": 0.25},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Försäljning EU-tjänster (B2B)',
  'Tjänsteförsäljning till annat EU-land (B2B). Ingen moms — kunden redovisar omvänd skattskyldighet.',
  'eu_trade', 'all', TRUE,
  '[
    {"account": "1510", "label": "Kundfordringar", "side": "debit", "type": "settlement", "ratio": 1.0},
    {"account": "3308", "label": "Försäljning tjänster EU", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Försäljning export (utanför EU)',
  'Försäljning till land utanför EU. Momsfritt.',
  'eu_trade', 'all', TRUE,
  '[
    {"account": "1510", "label": "Kundfordringar", "side": "debit", "type": "settlement", "ratio": 1.0},
    {"account": "3305", "label": "Försäljning export", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
);

-- TAX ACCOUNT
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Insättning skattekonto',
  'Betalning från företagskonto till skattekontot hos Skatteverket.',
  'tax_account', 'all', TRUE,
  '[
    {"account": "1630", "label": "Skattekonto", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Skatteåterbäring',
  'Återbetalning från skattekontot till företagskonto.',
  'tax_account', 'all', TRUE,
  '[
    {"account": "1930", "label": "Företagskonto", "side": "debit", "type": "settlement", "ratio": 1.0},
    {"account": "1630", "label": "Skattekonto", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Preliminär F-skatt (EF)',
  'Betalning av preliminär F-skatt från skattekontot (enskild firma).',
  'tax_account', 'enskild_firma', TRUE,
  '[
    {"account": "2012", "label": "Egna skatter", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1630", "label": "Skattekonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Preliminär F-skatt (AB)',
  'Betalning av preliminär bolagsskatt från skattekontot.',
  'tax_account', 'aktiebolag', TRUE,
  '[
    {"account": "2518", "label": "Betald F-skatt", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1630", "label": "Skattekonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Momsbetalning via skattekonto',
  'Moms som dras från skattekontot efter momsdeklaration.',
  'tax_account', 'all', TRUE,
  '[
    {"account": "2650", "label": "Redovisningskonto moms", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1630", "label": "Skattekonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Arbetsgivaravgifter via skattekonto',
  'Arbetsgivaravgifter som dras från skattekontot.',
  'tax_account', 'all', TRUE,
  '[
    {"account": "2731", "label": "Avräkning sociala avgifter", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1630", "label": "Skattekonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
);

-- PRIVATE TRANSFERS
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Eget uttag',
  'Privat uttag från företagskontot (enskild firma).',
  'private_transfer', 'enskild_firma', TRUE,
  '[
    {"account": "2013", "label": "Egna uttag", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Eget insättning',
  'Privat insättning till företagskontot (enskild firma).',
  'private_transfer', 'enskild_firma', TRUE,
  '[
    {"account": "1930", "label": "Företagskonto", "side": "debit", "type": "settlement", "ratio": 1.0},
    {"account": "2018", "label": "Egna insättningar", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Aktieägarlån — insättning',
  'Ägaren sätter in pengar som lån till bolaget.',
  'private_transfer', 'aktiebolag', TRUE,
  '[
    {"account": "1930", "label": "Företagskonto", "side": "debit", "type": "settlement", "ratio": 1.0},
    {"account": "2893", "label": "Skuld till aktieägare", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Aktieägarlån — återbetalning',
  'Bolaget betalar tillbaka lån till ägaren.',
  'private_transfer', 'aktiebolag', TRUE,
  '[
    {"account": "2893", "label": "Skuld till aktieägare", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Utdelning till aktieägare',
  'Utbetalning av beslutad utdelning till aktieägare.',
  'private_transfer', 'aktiebolag', TRUE,
  '[
    {"account": "2898", "label": "Outtagen utdelning", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
);

-- SALARY
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Löneutbetalning',
  'Utbetalning av nettolön till anställd.',
  'salary', 'aktiebolag', TRUE,
  '[
    {"account": "2710", "label": "Personalskatt", "side": "debit", "type": "business", "ratio": 0.3},
    {"account": "2920", "label": "Upplupna semesterlöner", "side": "debit", "type": "business", "ratio": 0.12},
    {"account": "7010", "label": "Löner", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Arbetsgivaravgifter',
  'Bokföring av arbetsgivaravgifter (31,42% av bruttolön).',
  'salary', 'aktiebolag', TRUE,
  '[
    {"account": "7510", "label": "Arbetsgivaravgifter", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "2731", "label": "Avräkning sociala avgifter", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
);

-- REPRESENTATION
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Representation (avdragsgill, 25% moms)',
  'Extern representation med avdragsgill moms. Max 300 kr/person exkl. moms.',
  'representation', 'all', TRUE,
  '[
    {"account": "6072", "label": "Representation avdragsgill", "side": "debit", "type": "business", "ratio": 0.8},
    {"account": "2641", "label": "Ingående moms", "side": "debit", "type": "vat", "vat_rate": 0.25},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
);

-- YEAR-END / FINANCIAL
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Periodiseringsfond avsättning (AB)',
  'Avsättning till periodiseringsfond vid bokslut. Max 25% av överskottet.',
  'year_end', 'aktiebolag', TRUE,
  '[
    {"account": "8811", "label": "Avsättning periodiseringsfond", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "2113", "label": "Periodiseringsfond", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Periodiseringsfond återföring (AB)',
  'Återföring av periodiseringsfond (senast efter 6 år).',
  'year_end', 'aktiebolag', TRUE,
  '[
    {"account": "2113", "label": "Periodiseringsfond", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "8819", "label": "Återföring periodiseringsfond", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Beräknad bolagsskatt',
  'Bokföring av beräknad inkomstskatt vid bokslut.',
  'year_end', 'aktiebolag', TRUE,
  '[
    {"account": "8910", "label": "Skatt på årets resultat", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "2512", "label": "Beräknad inkomstskatt", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Överavskrivning inventarier',
  'Bokföring av överavskrivning (skillnad räkenskapsenlig vs planenlig).',
  'year_end', 'aktiebolag', TRUE,
  '[
    {"account": "8850", "label": "Förändring överavskrivning", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "2150", "label": "Ackumulerade överavskrivningar", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
);

-- VAT
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Momsredovisning (nettning)',
  'Nettning av momskonton vid momsdeklaration. Justera konton och belopp efter din deklaration.',
  'vat', 'all', TRUE,
  '[
    {"account": "2611", "label": "Utgående moms 25%", "side": "debit", "type": "business", "ratio": 0.5},
    {"account": "2641", "label": "Ingående moms", "side": "credit", "type": "business", "ratio": 0.3},
    {"account": "2650", "label": "Redovisningskonto moms", "side": "credit", "type": "business", "ratio": 0.2}
  ]'::jsonb
);

-- FINANCIAL
INSERT INTO public.booking_template_library (name, description, category, entity_type, is_system, lines) VALUES
(
  'Bankavgift',
  'Månadsavgift eller transaktionsavgift från banken.',
  'financial', 'all', TRUE,
  '[
    {"account": "6570", "label": "Bankkostnader", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
),
(
  'Ränteintäkt',
  'Ränta från sparkonto eller bank.',
  'financial', 'all', TRUE,
  '[
    {"account": "1930", "label": "Företagskonto", "side": "debit", "type": "settlement", "ratio": 1.0},
    {"account": "8311", "label": "Ränteintäkter", "side": "credit", "type": "business", "ratio": 1.0}
  ]'::jsonb
),
(
  'Räntekostnad',
  'Ränta på lån eller kredit.',
  'financial', 'all', TRUE,
  '[
    {"account": "8410", "label": "Räntekostnader", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1930", "label": "Företagskonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb
);

-- Schema reload for PostgREST
NOTIFY pgrst, 'reload schema';
