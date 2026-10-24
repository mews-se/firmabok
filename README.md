# Firmabok

[![build](https://img.shields.io/github/actions/workflow/status/mews-se/firmabok/docker-publish.yml?branch=main&label=build)](https://github.com/mews-se/firmabok/actions/workflows/docker-publish.yml)
[![codeql](https://img.shields.io/github/actions/workflow/status/mews-se/firmabok/codeql.yml?branch=main&label=codeql)](https://github.com/mews-se/firmabok/actions/workflows/codeql.yml)
[![release](https://img.shields.io/github/v/release/mews-se/firmabok?label=release)](https://github.com/mews-se/firmabok/releases)
[![licens](https://img.shields.io/github/license/mews-se/firmabok?label=licens)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6.svg?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1.svg?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED.svg?logo=docker&logoColor=white)

Svensk bokföring för enskild firma, byggd för självhostad drift på eget
nätverk, utan molnberoenden, integrationer eller inbyggd AI.

## Bakgrund

Firmabok bygger på [Accounted](https://github.com/erp-mafia/accounted)
(erp-mafia): bokföringsmotorn, regelefterlevnaden i databasen,
rapporterna och SIE-stödet är uppströmsprojektets förtjänst. Uppströms
är ett flerbolags-SaaS med bankkoppling, AI-assistent, löner och
aktiebolagsstöd; vill du ha det är
[originalet](https://github.com/erp-mafia/accounted) rätt val. Firmabok
är samma motor med allt molnberoende bortplockat: en enda enskild
firma, på egen server, utan konton hos tredje part och utan att en
tjänsts livscykel avgör om bokföringen går att öppna om sju år.

Uppströms inloggnings- och säkerhetslager (BankID, MFA-krav,
telemetri) är också bortrensade och sessionstimeouts avstängda som
standard, så installationen ska stå på eget nätverk bakom egen kontroll
och aldrig exponeras som öppen tjänst mot internet eller delas med folk
du inte litar på.

## Funktioner

**Bokföring.** Dubbel bokföring med BAS 2026-kontoplanen. Verifikat
skapas som utkast och bokförs; bokförda verifikat rättas spårbart,
antingen som inline-rättelse i samma verifikat med logg över vem och
när (BFL 5 kap 5 och 9 §§) eller som storno som återför hela
verifikationen. Debet=kredit, obruten nummerserie, periodlås och
arkiveringsskyddet upprätthålls av databasens egna triggrar, inte bara
av appkoden. Både faktureringsmetoden och kontantmetoden stöds; under
kontantmetoden bokförs intäkter, kostnader och moms när betalningen
sker.

**Dokumentinkorg.** Kvitton, fakturor och avtal släpps under Underlag,
förhandsgranskas och blir underlag: koppla till befintligt verifikat,
bokför direkt eller skapa leverantörsfaktura. Dokument som nått
bokföringen räknas som räkenskapsinformation och skyddas mot radering.

**Fakturering.** Kundfakturor, enstaka eller återkommande, med
PDF-export, kreditfaktura, ROT/RUT, utländsk valuta och manuell
betalningsregistrering, även delbetalningar; leverantörsfakturor med
attest och underlag. Inget utskick: PDF:en skickas hur du vill.

**Moms och rapporter.** Momsdeklarationens rutor (SKV 4700) räknas fram
ur bokföringen och kan laddas ner som eSKD-fil. Bland rapporterna finns
periodisk sammanställning, huvudbok, resultat- och balansräkning,
råbalans samt kund- och leverantörsreskontra.

**Årsbokslut.** Förenklat årsbokslut för enskild firma med NE-bilagans
fält och SRU-fil till Skatteverket, avskrivningar ur
anläggningsregistret, periodiseringar och dispositioner.

**SIE.** Import och export av SIE4: historiken från andra program
följer med in, och allt går att ta med sig ut igen.

**MCP och API.** Den inbyggda AI:n är borta men maskinvägen är öppen:
en MCP-server med API-nycklar låter en AI-agent (t.ex. Claude) eller
egna skript sköta bokföringen. Skrivande verktyg lägger förslag som
godkänns under Granskning innan de bokförs.

## Installation och drift

Allt som behövs är en färdig Debian-server och serverns LAN-IP.
Adressen skrivs in i `.env` en gång, så ge servern en fast IP eller en
DHCP-reservation i routern. Exemplet använder `10.0.0.30`, byt mot din
egen. Kör som vanlig användare; sudo används bara för att installera
paket som saknas och för Docker så länge din användare inte är med i
gruppen `docker`:

```bash
wget -O install-debian.sh https://raw.githubusercontent.com/mews-se/firmabok/main/install-debian.sh
sh install-debian.sh 10.0.0.30
```

[install-debian.sh](install-debian.sh) gör resten självt: hämtar repot,
installerar Docker, genererar hemligheterna och startar hela stacken ur
[docker-compose.yml](docker-compose.yml): appen, dess cron-sidovagn
och tjänsterna den behöver (postgres, GoTrue, PostgREST), bakom en tunn
nginx på en gemensam adress. Migrationerna körs automatiskt, även vid
uppdateringar. Ren HTTP på det egna nätet, som allt annat i stacken.
Internet behövs bara vid installation och uppdatering samt för
momsnummerkontrollen mot VIES och valutakurserna från Riksbanken; allt
annat fungerar utan uppkoppling.

Surfa sedan till `http://10.0.0.30` och skapa kontot (e-postadressen
är bara ett lokalt användarnamn, ingen mail skickas någonsin), gå
igenom onboardingen och stäng därefter registreringen:

```bash
~/firmabok/install-debian.sh lock
```

**Uppdatering.** När en ny release är ute kör du samma två kommandon som
vid installationen, i hemkatalogen (inifrån `~/firmabok` hämtas ingen
ny kod):

```bash
wget -O install-debian.sh https://raw.githubusercontent.com/mews-se/firmabok/main/install-debian.sh
sh install-debian.sh 10.0.0.30
```

Har du utcheckningen kvar går det lika bra därifrån, men då måste du
hämta hem den nya versionen själv först:

```bash
cd ~/firmabok && git pull --ff-only && ./install-debian.sh 10.0.0.30
```

Båda vägarna hämtar det som ligger på main, inte en viss release, kör
bara de nya migrationerna och startar om med appimagen `latest`,
publicerad till `ghcr.io/mews-se/firmabok` och speglad till Docker Hub
som [`mewsse/firmabok`](https://hub.docker.com/r/mewsse/firmabok),
samma byggen och versionstaggar. Din `.env` och dina volymer lämnas
orörda.

**Backup.** Ditt ansvar: `pg_dump` mot en annan maskin, gärna
kompletterat med SIE-export per räkenskapsår. Underlagen ligger i
volymen `storage_data` och följer inte med i någon av dem; kopiera
volymen eller ladda ner Komplett arkiv under Importera/Exportera, en
ZIP med SIE, rapporter och alla underlag.

**Stopp och avinstallation.** Vardagskommandona körs i `~/firmabok`:
`docker compose stop`, `start`, `logs`. Om skriptet installerade Docker
behövs `sudo` framför dem tills du lagt till dig i gruppen `docker` och
loggat in igen; skriptet skriver ut kommandot för det. Avinstallation:
`docker compose down -v` (tar containrarna och ALL data) och ta sedan
bort katalogen.

**Fördjupning.** [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) beskriver
arkitekturen, miljövariablerna, backupkommandona och bygge från källa.
[CHANGELOG.md](CHANGELOG.md) sammanfattar vad varje version ändrade.

## Instruktion

Logga in och skapa företaget vid första starten. Finns bokföring sedan
tidigare importeras den via SIE.

Vardagsflödet: släpp kvitton och fakturor under Underlag, bokför dem som
verifikat eller skapa leverantörsfaktura direkt från underlaget.
Kundfakturor skapas under Kundfakturor och exporteras som PDF;
betalningar registreras manuellt med Markera som betald. Momsunderlaget
(SKV 4700) räknas fram under Moms, och vid årets slut finns Årsbokslut
och Inkomstdeklaration (NE-bilagan) för enskild firma.

Claude kopplas via MCP: skapa en API-nyckel under Inställningar → API och
koppla Claude Desktop med stdio-bryggan `npx gnubok-mcp`, som kräver
Node.js 18 eller senare på datorn med Claude Desktop. Bryggan går som
standard mot uppströms molntjänst, så `GNUBOK_URL` måste peka på din
egen server, annars svarar varje nyckel med 401. Så här ska posten
under `mcpServers` i `claude_desktop_config.json` se ut, med serverns
adress och nyckeln ifyllda:

```json
"firmabok": {
  "command": "npx",
  "args": ["gnubok-mcp"],
  "env": {
    "GNUBOK_URL": "http://<lan-ip>/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted",
    "GNUBOK_API_KEY": "gnubok_sk_..."
  }
}
```

Starta om Claude Desktop helt efteråt; bryggan läser inställningarna
bara vid start. Andra MCP-klienter pekas mot samma adress med nyckeln
som `Authorization: Bearer`.

Vad MCP-verktygen inte klarar, och hur samma sak görs i webben, står i
[docs/mcp-kanda-begransningar.md](docs/mcp-kanda-begransningar.md).

Uppströms finns dessutom
[swedish-accounting-skills](https://github.com/erp-mafia/swedish-accounting-skills):
fristående Claude-skills som täcker mer än Firmabok gör (AB-bokslut,
lön, skatteplanering) och fungerar utan någon appkoppling.

## Licens

[AGPL-3.0-or-later](LICENSE), samma som uppströms. Tredjepartserkännanden i
[NOTICE](NOTICE).
