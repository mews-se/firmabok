# Firmabok

Svensk bokföring för enskild firma, byggd för självhostad drift på eget
nätverk — utan molnberoenden, integrationer eller inbyggd AI.

Firmabok bygger på [Accounted](https://github.com/erp-mafia/accounted)
(erp-mafia). Allt kvalificerat arbete — bokföringsmotorn, regelefterlevnaden
i databasen, rapporterna, SIE-stödet — är uppströmsprojektets förtjänst.
Vill du ha en fullfjädrad, hostad tjänst med bankkoppling, AI-assistent och
fler bolagsformer är [originalet](https://github.com/erp-mafia/accounted)
rätt val.

## Vad Firmabok är

Det som en ensam enskild firma behöver, och inget mer:

- Dubbel bokföring med BAS 2026, verifikat med draft/commit och
  inline-rättelse enligt BFL
- Dokumentinkorg för underlag: ladda upp, förhandsgranska, koppla till
  verifikat eller skapa leverantörsfaktura
- Fakturering med PDF-export, leverantörsfakturor, dokumentarkiv
- SIE import/export, momsdeklaration (SKV 4700), NE-bilaga och
  rapporterna, plus årsbokslut för enskild firma
- MCP-server: bokföringen kan skötas av en AI-agent (t.ex. Claude) med
  egen API-nyckel — alla skrivningar kräver manuellt godkännande i appen

Borttaget relativt uppströms: AI-assistent och LLM-koppling i appen,
bankkoppling (PSD2), betalnings- och e-postintegrationer, Skatteverkets
inlämnings-API, löner/AGI, aktiebolagsdelarna (INK2, digital
årsredovisning), transaktionsinbox och publika REST-API:t.

## Drift

Docker plus självhostad Supabase, allt lokalt. HTTPS krävs även på LAN
(secure cookies) — medföljande Caddy-overlay kör `tls internal` som
standard. Se [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

Färdig image publiceras till `ghcr.io/mews-se/firmabok`.

## Licens

[AGPL-3.0-or-later](LICENSE), samma som uppströms. Tredjepartserkännanden i
[NOTICE](NOTICE).
