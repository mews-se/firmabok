# Firmabok

[![build](https://img.shields.io/github/actions/workflow/status/mews-se/firmabok/docker-publish.yml?branch=main&label=build)](https://github.com/mews-se/firmabok/actions/workflows/docker-publish.yml)
[![codeql](https://img.shields.io/github/actions/workflow/status/mews-se/firmabok/codeql.yml?branch=main&label=codeql)](https://github.com/mews-se/firmabok/actions/workflows/codeql.yml)
[![release](https://img.shields.io/github/v/release/mews-se/firmabok?label=release)](https://github.com/mews-se/firmabok/releases)
[![licens](https://img.shields.io/github/license/mews-se/firmabok?label=licens)](LICENSE)

Svensk bokföring för enskild firma, byggd för självhostad drift på eget
nätverk — utan molnberoenden, integrationer eller inbyggd AI.

## Bakgrund

Firmabok bygger på [Accounted](https://github.com/erp-mafia/accounted)
(erp-mafia). Allt kvalificerat arbete — bokföringsmotorn,
regelefterlevnaden i databasen, rapporterna, SIE-stödet — är
uppströmsprojektets förtjänst. Vill du ha en fullfjädrad, hostad tjänst
med bankkoppling, AI-assistent och fler bolagsformer är
[originalet](https://github.com/erp-mafia/accounted) rätt val.

Forken uppstod ur ett konkret behov: en enda enskild firma, bokförd på
egen server i det egna nätverket, utan konton hos tredje part och utan
att en molntjänsts livscykel avgör om bokföringen går att öppna om sju
år. Uppströms är byggt som flerbolags-SaaS med betalväggar,
integrationer och inbyggd AI — Firmabok är samma motor med allt sådant
bortplockat och självhostning som enda spår.

Bortplockat relativt uppströms: AI-assistenten och LLM-kopplingen i
appen, bankkoppling (PSD2), betalnings- och e-postintegrationer,
Skatteverkets inlämnings-API, löner/AGI, aktiebolagsdelarna (INK2,
digital årsredovisning), transaktionsinbox, betalvägg och
prenumerationer samt publika REST-API:t.

Att den inbyggda AI:n är borta betyder inte att maskinvägen är stängd:
MCP-servern och API-nycklarna är kvar, så bokföringen kan skötas
programmatiskt av valfri MCP-klient eller egna skript — det är själva
LLM-anropen ur appen som är borttagna, inte gränssnittet mot dem.

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

**MCP och API.** Inbyggd MCP-server med API-nycklar: bokföringen kan
skötas av en AI-agent (t.ex. Claude) eller egna skript. Skrivande
verktyg lägger förslag som godkänns innan de bokförs.

## Säkerhet och målgrupp

Firmabok är uttryckligen byggt för en enskild firma på egen server,
inget annat. Uppströms inloggnings- och säkerhetslager — BankID, MFA,
sessionstimeouts, telemetri — är bortrensade, så installationen ska stå
på eget nätverk bakom egen kontroll och aldrig exponeras som öppen
tjänst mot internet eller delas med folk du inte litar på.

## Installation på en Debian-server

Allt som behövs är en färdig Debian-server och serverns LAN-IP —
exemplet använder `10.0.0.30`, byt mot din egen. Kör som vanlig
användare; sudo används bara om Docker eller git saknas:

```bash
wget -O install-debian.sh https://raw.githubusercontent.com/mews-se/firmabok/main/install-debian.sh
sh install-debian.sh 10.0.0.30
```

[install-debian.sh](install-debian.sh) gör resten självt: hämtar repot,
installerar Docker, genererar hemligheterna och startar hela stacken ur
en enda compose-fil —
[docker-compose.selfhost.yml](docker-compose.selfhost.yml) — med appen
och de fem Supabase-tjänster den behöver (databas, inloggning, API,
realtid, dokumentlagring) bakom en gemensam adress. Migrationerna körs
automatiskt, även vid uppdateringar. Vill du se exakt vad som körs är
compose-filen och skriptet läsbara.

Surfa sedan till `http://10.0.0.30` — ren HTTP, inga certifikat och
inga varningar; stacken är byggd för det egna nätverket och inget
annat. Skapa kontot — e-postadressen är bara ett lokalt användarnamn,
så den behöver inte vara en riktig adress (ingen mail skickas
någonsin) — gå igenom onboardingen och stäng därefter registreringen:

```bash
~/firmabok/install-debian.sh lock
```

### Uppdatering

Kör samma två kommandon som vid installationen: skriptet hämtar
senaste versionen, kör bara de nya migrationerna och startar om med
den nya appimagen. Backup är ditt ansvar — `pg_dump` mot en annan
maskin, gärna kompletterat med SIE-export per räkenskapsår (se
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)).

## Instruktion

Logga in och skapa företaget vid första starten (självhostat bekräftas
kontot direkt, ingen e-post behövs). Finns bokföring sedan tidigare
importeras den via SIE.

Vardagsflödet: släpp kvitton och fakturor i inkorgen, bokför dem som
verifikat eller skapa leverantörsfaktura direkt från underlaget.
Kundfakturor skapas under Fakturor och exporteras som PDF; betalningar
registreras manuellt. Momsunderlaget (SKV 4700) räknas fram under
Rapporter, och vid årets slut finns NE-bilaga och årsbokslut för enskild
firma.

Claude kopplas via MCP: skapa en API-nyckel under Inställningar → API och
peka klienten mot
`/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted` på din egen
host (stdio-brygga: `npx accounted-mcp`). Kunskapen om svensk bokföring
(BFL, moms, SIE) följer med i appens MCP-server; uppströms finns dessutom
[swedish-accounting-skills](https://github.com/erp-mafia/swedish-accounting-skills)
— fristående Claude-skills som täcker mer än Firmabok gör (AB-bokslut,
lön, skatteplanering) och fungerar i Claude Desktop och Claude Code utan
någon appkoppling.

## Drift

Docker rakt igenom, allt lokalt. Hela stacken bor i
[docker-compose.selfhost.yml](docker-compose.selfhost.yml): en tunn
nginx är enda ingången och bara de Supabase-tjänster appen använder
körs. Ren
HTTP på det egna nätet — cookies följer adressens schema, så en
https-adress bakom egen proxy fungerar också om man hellre vill det.
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) fördjupar: varianten med
Supabase-moln, Synology/NAS, bygge från källa och backup.

Färdig image publiceras till `ghcr.io/mews-se/firmabok`.

## Licens

[AGPL-3.0-or-later](LICENSE), samma som uppströms. Tredjepartserkännanden i
[NOTICE](NOTICE).
