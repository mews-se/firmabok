# Firmabok

[![build](https://img.shields.io/github/actions/workflow/status/mews-se/firmabok/docker-publish.yml?branch=main&label=build)](https://github.com/mews-se/firmabok/actions/workflows/docker-publish.yml)
[![codeql](https://img.shields.io/github/actions/workflow/status/mews-se/firmabok/codeql.yml?branch=main&label=codeql)](https://github.com/mews-se/firmabok/actions/workflows/codeql.yml)
[![release](https://img.shields.io/github/v/release/mews-se/firmabok?label=release)](https://github.com/mews-se/firmabok/releases)
[![licens](https://img.shields.io/github/license/mews-se/firmabok?label=licens)](LICENSE)

Svensk bokföring för enskild firma, byggd för självhostad drift på eget
nätverk — utan molnberoenden, integrationer eller inbyggd AI.

## Bakgrund

Firmabok bygger på [Accounted](https://github.com/erp-mafia/accounted)
(erp-mafia) — bokföringsmotorn, regelefterlevnaden i databasen,
rapporterna och SIE-stödet är uppströmsprojektets förtjänst. Uppströms
är ett flerbolags-SaaS med bankkoppling, AI-assistent, löner och
aktiebolagsstöd; vill du ha det är
[originalet](https://github.com/erp-mafia/accounted) rätt val. Firmabok
är samma motor med allt molnberoende bortplockat: en enda enskild
firma, på egen server, utan konton hos tredje part och utan att en
tjänsts livscykel avgör om bokföringen går att öppna om sju år.

Uppströms inloggnings- och säkerhetslager (BankID, MFA-krav,
sessionstimeouts, telemetri) är också bortrensade, så installationen
ska stå på eget nätverk bakom egen kontroll — aldrig exponeras som
öppen tjänst mot internet eller delas med folk du inte litar på.

## Funktioner

**Bokföring.** Dubbel bokföring med BAS 2026-kontoplanen. Verifikat
skapas som utkast och bokförs; bokförda verifikat rättas spårbart,
antingen som inline-rättelse i samma verifikat med logg över vem och
när (BFL 5 kap 5 och 9 §§) eller som storno som återför hela
verifikationen. Debet=kredit, obruten nummerserie, periodlås och
arkiveringsskyddet upprätthålls av databasens egna triggrar, inte bara
av appkoden.

**Dokumentinkorg.** Kvitton, fakturor och avtal släpps i inkorgen,
förhandsgranskas och blir underlag: koppla till befintligt verifikat,
bokför direkt eller skapa leverantörsfaktura. Dokument som nått
bokföringen räknas som räkenskapsinformation och skyddas mot radering.

**Fakturering.** Kundfakturor med PDF-export, kreditfaktura, ROT/RUT
och manuell betalningsregistrering; leverantörsfakturor med attest och
underlag. Inget utskick — PDF:en skickas hur du vill.

**Moms och rapporter.** Momsdeklarationens rutor (SKV 4700) räknas fram
ur bokföringen, tillsammans med huvudbok, resultat- och balansräkning
och råbalans.

**Årsbokslut.** Förenklat årsbokslut för enskild firma med NE-bilagans
fält, avskrivningar och dispositioner.

**SIE.** Import och export av SIE4 — historiken från andra program
följer med in, och allt går att ta med sig ut igen.

**MCP och API.** Den inbyggda AI:n är borta men maskinvägen är öppen:
en MCP-server med API-nycklar låter en AI-agent (t.ex. Claude) eller
egna skript sköta bokföringen. Skrivande verktyg lägger förslag som
godkänns innan de bokförs.

## Installation och drift

Allt som behövs är en färdig Debian-server och serverns LAN-IP —
exemplet använder `10.0.0.30`, byt mot din egen. Kör som vanlig
användare; sudo används bara om Docker eller git saknas:

```bash
wget -O install-debian.sh https://raw.githubusercontent.com/mews-se/firmabok/main/install-debian.sh
sh install-debian.sh 10.0.0.30
```

[install-debian.sh](install-debian.sh) gör resten självt: hämtar repot,
installerar Docker, genererar hemligheterna och startar hela stacken ur
[docker-compose.yml](docker-compose.yml) — appen och
de fyra Supabase-tjänster den behöver, bakom en tunn nginx på en
gemensam adress. Migrationerna körs automatiskt, även vid
uppdateringar. Ren HTTP på det egna nätet; cookies följer adressens
schema, så en https-adress bakom egen proxy fungerar också.

Surfa sedan till `http://10.0.0.30` och skapa kontot — e-postadressen
är bara ett lokalt användarnamn, ingen mail skickas någonsin — gå
igenom onboardingen och stäng därefter registreringen:

```bash
~/firmabok/install-debian.sh lock
```

**Uppdatering.** Kör samma två kommandon som vid installationen:
skriptet hämtar senaste versionen, kör bara de nya migrationerna och
startar om med den nya appimagen, publicerad till
`ghcr.io/mews-se/firmabok`.

**Backup.** Ditt ansvar: `pg_dump` mot en annan maskin, gärna
kompletterat med SIE-export per räkenskapsår.

**Stopp och avinstallation.** Vardagskommandona fungerar rakt av i
`~/firmabok`: `docker compose stop`, `start`, `logs`. Avinstallation:
`docker compose down -v` (tar containrarna och ALL data) och ta sedan
bort katalogen.

**Fördjupning.** [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) beskriver
arkitekturen, miljövariablerna, backupkommandona och bygge från källa.

## Instruktion

Logga in och skapa företaget vid första starten. Finns bokföring sedan
tidigare importeras den via SIE.

Vardagsflödet: släpp kvitton och fakturor i inkorgen, bokför dem som
verifikat eller skapa leverantörsfaktura direkt från underlaget.
Kundfakturor skapas under Fakturor och exporteras som PDF; betalningar
registreras manuellt. Momsunderlaget (SKV 4700) räknas fram under
Rapporter, och vid årets slut finns NE-bilaga och årsbokslut för enskild
firma.

Claude kopplas via MCP: skapa en API-nyckel under Inställningar → API och
peka klienten mot
`/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted` på din egen
host (stdio-brygga: `npx accounted-mcp`). Uppströms finns dessutom
[swedish-accounting-skills](https://github.com/erp-mafia/swedish-accounting-skills)
— fristående Claude-skills som täcker mer än Firmabok gör (AB-bokslut,
lön, skatteplanering) och fungerar utan någon appkoppling.

## Licens

[AGPL-3.0-or-later](LICENSE), samma som uppströms. Tredjepartserkännanden i
[NOTICE](NOTICE).
