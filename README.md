# Accounted — personlig fork

Svensk bokföring för enskild firma, nedbantad för privat drift på eget LAN.

Det här är en personlig fork av [Accounted](https://github.com/erp-mafia/accounted)
(erp-mafia). Allt kvalificerat arbete — bokföringsmotorn, regelefterlevnaden i
databasen, rapporterna, SIE-stödet — är uppströmsprojektets förtjänst. Är du
inte jag vill du nästan säkert använda [originalet](https://github.com/erp-mafia/accounted)
i stället: det är aktivt utvecklat, dokumenterat och byggt för fler än en
användare.

## Vad som skiljer mot uppströms

Forken är avskalad till det en ensam enskild firma på ett privat nät behöver.
Borttaget:

- AI-assistenten och all LLM-koppling i själva appen
- Bankkoppling (PSD2), Stripe, WooCommerce, WhatsApp och e-postutskick
- Skatteverkets inlämnings-API och BankID
- Löner, lönebesked och AGI
- INK2, digital årsredovisning och iXBRL (aktiebolagsdelarna)
- Publika REST-API:t, demo-sandboxen och övrig SaaS-apparat

Kvar och oförändrat från uppströms:

- Dubbel bokföring med BAS 2026, verifikat med draft/commit och inline-rättelse
- Fakturering med PDF-export, leverantörsfakturor, dokumentarkiv
- SIE import/export, momsdeklaration (SKV 4700), NE-bilaga, rapporterna och
  årsbokslut för enskild firma
- MCP-servern: bokföringen kan skötas av en AI-agent utifrån med egen
  API-nyckel, och alla skrivningar kräver manuellt godkännande i appen

## Drift

Docker plus självhostad Supabase, allt lokalt. Se
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## Licens

[AGPL-3.0-or-later](LICENSE), samma som uppströms. Tredjepartserkännanden i
[NOTICE](NOTICE).
