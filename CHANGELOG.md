# Ändringslogg

Alla märkbara ändringar i Firmabok, nyaste först. Versionerna följer
taggarna i det här repot; varje version publiceras som containerimage på
`ghcr.io/mews-se/firmabok`.

## 4.3.0 — 2026-10-01

Dependabots månadsomgång; imagen byggs om på aktuell node:26-alpine med
de uppdaterade paketen. Ingen kodändring.

- react och react-dom uppdateras från 19.2.8 till 19.3.0, zod från 4.4.3
  till 4.6.5, next-intl från 4.13.7 till 4.14.7, @supabase/ssr från
  0.12.5 till 0.12.7, @react-pdf/renderer från 4.8.1 till 4.9.0,
  framer-motion från 13.1.1 till 13.4.3, lucide-react från 1.34.0 till
  1.48.0, react-hook-form från 7.86.0 till 7.88.0, tailwind-merge från
  3.6.0 till 3.7.0, js-yaml från 5.4.1 till 5.4.2, jszip från 3.10.1 till
  3.10.2, posthog-js och posthog-node till 1.434.12 och 5.53.0,
  @upstash/ratelimit och @upstash/redis till 2.2.0 och 1.39.0.
  eslint-config-next uppdateras från 16.3.2 till 16.3.6 (utveckling).
- Basimagen node:26-alpine flyttas till aktuell digest.
- vitest uppdateras från 4.1.11 till 5.0.1 och dotenv från 17.4.2 till
  18.0.3, båda bara för utveckling. Vitest 5 kräver Node 22, så de
  workflows som låser en Node-version går från 20 till 22.
- github/codeql-action uppdateras till 4.38.2, docker/setup-buildx-action
  till 4.4.1 och docker/build-push-action till 7.4.0 i workflowsen.
- eslint stannar på 9 tills vidare: det eslint-plugin-react som följer med
  eslint-config-next fungerar inte med ESLint 10 än.


## 4.2.3 — 2026-09-30

Säkerhetsuppdatering från Dependabot; imagen byggs om med de lagade
paketen.

- next uppdateras från 16.3.4 till 16.3.8 och åtgärdar
  GHSA-vcvr-r3jv-pc5j, fjärrkörning av kod i next/og ImageResponse,
  rättad i 16.3.6. En LAN-installation är inte exponerad mot internet,
  men rättelsen är en vanlig patchuppdatering.
- dompurify uppdateras från 3.4.13 till 3.4.16 och åtgärdar
  GHSA-p98j-92pf-mc4p, där en afterSanitize-hook som tar bort noder kunde
  lämna händelsehanterare aktiva i det frikopplade delträdet.
- De två kopiorna av brace-expansion under byggverktygen uppdateras till
  1.1.21 och 2.1.7 och åtgärdar GHSA-q2hr-2g5m-vwhr, en expansion i
  kvadratisk tid av omskrivningen `{a},b}`. Bara för utveckling.


## 4.2.2 — 2026-09-30

Säkerhetsuppdatering från Dependabot; imagen byggs om med det lagade
js-yaml.

- js-yaml uppdateras från 5.4.0 till 5.4.1 och åtgärdar
  GHSA-r3ph-w7gj-g6xm, där maxTotalMergeKeys inte räknade tomma
  merge-källor, så att ett preparerat dokument kunde hålla inläsaren
  sysselsatt långt över den inställda gränsen. js-yaml läser mallpaketen.
- @babel/core uppdateras från 7.28.6 till 7.29.7 och åtgärdar
  GHSA-4x5r-pxfx-6jf8, godtycklig filläsning via en
  sourceMappingURL-kommentar. Paketet nås bara via
  eslint-plugin-react-hooks och installeras aldrig annat än för
  utveckling; resten av babel-kedjan och browserslists datapaket följer
  med.


## 4.2.1 — 2026-09-11

Säkerhetsuppdatering; imagen byggs om med de lagade paketen.

- next uppdateras från 16.3.2 till 16.3.4 och åtgärdar
  GHSA-2xp9-vwfh-vxw4 och GHSA-p293-qw3h-jr36, fjärrkörning av kod utan
  inloggning i bildoptimeringens API. En LAN-installation är inte
  exponerad mot internet, men rättelsen är en vanlig patchuppdatering.
- sharp uppdateras från 0.35.3 till 0.35.4 (libvips 1.3.3) och åtgärdar
  GHSA-rgj7-g3m4-5g8c i libheif. sharp konverterar logotypen till
  faktura-PDF:en.
- Kopian av js-yaml 4.x under eslint-kedjan uppdateras till 4.3.2 och
  åtgärdar GHSA-2883-xcg3-v3hh. Bara för utveckling.


## 4.2.0 — 2026-09-11

Trettio ändringar portade från uppströms Accounted, begränsade till det
en LAN-installation har nytta av. Sex nya migrationer körs vid nästa
start.

Rättat:

- Bokföringsmallarna räknade momsen vid omvänd skattskyldighet som
  sats/(1+sats) av totalen, så 25 % blev 20 % på paret 2614/2645; den
  självberäknade momsen läggs nu ovanpå underlaget. Konto 2012 finns inte
  i officiella BAS: referensen tar bort det och EF-mallen för F-skatt
  bokför på 2013, med befintliga mallrader flyttade. Entré till dans har
  6 % moms från 2026-07-01. Företagets eget kontonamn går före
  BAS-referensens namn, och 1580 förlorar sin hårdkodade benämning som
  skattefordran.
- Nyckeltalens månadsuppdelning räknar makulerade original på samma sätt
  som årstotalen, så att månaderna åter summerar till Nettoresultat, och
  stapeletiketterna klipps inte längre.
- SIE: uppladdningen fungerar i Safari och nekar fel filtyp synligt,
  förhandsvisningen benämner IB-debetsumman rätt, konton skapas i
  omgångar och importraden stängs vid varje utgång, och redan avkodad
  text med CP437-mojibake fångas. Ett första räkenskapsår får börja mitt
  i en månad; ingående balanser och periodkedjan litar bara på perioder
  som ligger direkt intill varandra i datum.
- Momsdeklarationen hämtar sin rytm från den inställda
  redovisningsperioden vid varje besök, och ett företag utan
  skatteinställningar skickas vidare för att ställa in dem i stället för
  att få en gissad kvartalsdeklaration.
- Återkommande fakturor tvingar 0 % moms när företaget inte är
  momsregistrerat.
- Rader på leverantörsfakturor med negativt belopp (öresavrundning,
  rabatt) bokförs på motsatt sida i stället för som negativa belopp, och
  en faktura som summerar under noll förankras på debetsidan. Alla
  skrivvägar nekar nu negativa debet- och kreditbelopp.
- En obetald faktura kan inte längre sparas med remaining_amount 0.
- Alla skrivningar av fakturor nekar ett artikel-id som tillhör ett annat
  företag.
- Arkivets integritetskontroller registreras i en egen logg, så att den
  nattliga kontrollen går framåt igen.
- Kunder och leverantörer accepterar betalningsvillkor på 0 dagar, och
  fältet säger varför ett värde är ogiltigt.
- Lagstadgade upplysningar på faktura-PDF:en följer dokumentets språk.
- Verifikatsökningen hittar en verifikation på dess beteckning ("A209",
  "a 209"), med en spinner medan den söker.
- ContextPicker-listorna fungerar i dialoger, och tabellerna på
  leverantörsfakturans detaljsida får luft mellan kolumnerna.
- MCP: query_journal accepterar ett enskilt konto eller ett nummer i
  stället för att tyst släppa filtret, och listverktygen bläddrar förbi
  PostgREST:s tak på 1000 rader.

Nytt:

- Hela arkivet (SIE per räkenskapsår, rapporter, behandlingshistorik och
  alla dokument) kan laddas ner från fliken Exportera. Tidigare nåddes
  det bara via MCP-verktyget.
- Mina konton: kolumnen Verifikat är ett filter, och oanvända konton kan
  inaktiveras flera åt gången.
- Momsdeklarationen visar en banner när perioden redan är bokförd.
- Reglaget för automatiska påminnelser finns under Fakturering, och
  fakturasidan säger när påminnelserna är avstängda.
- Återkommande scheman tar ett datum för första fakturan, så att ett
  årligt schema fakturerar i den månad du väljer.
- Nyckeltal listar varje månads resultat och en tabell månad för månad,
  med ett reglage i Anpassa.
- Raderna i MCP:s create_invoice accepterar ett artikel-id, förifyllt som
  i webbens radväljare.
- Ett bokfört 8999 visas i Resultatrapport i stället för att döljas.
- Importfliken visar historiken över SIE-importer, med ångra.
- 22 nya bokföringsmallar: varor och material, skatte- och
  momsavräkningar, bokslutsposter.
- Dimensionsväljarna visar värdets namn efter valet, och en oanvänd egen
  dimension kan tas bort.
- Verifikatsidan visar vem som bokförde verifikationen.


## 4.1.4 — 2026-09-04

Säkerhetsuppdatering från Dependabot; inget i imagen ändras.

- browserslist uppdateras från 4.28.1 till 4.28.8 och åtgärdar
  GHSA-73wf-gq98-2v4g, där en preparerad browserslist-stats.json kunde
  krascha processen eller skriva till prototypen. Dess datapaket
  (caniuse-lite, electron-to-chromium, node-releases) uppdateras
  samtidigt. Paketet är ett byggverktyg och installeras aldrig annat än
  för utveckling.

## 4.1.3 — 2026-09-04

Säkerhetsuppdatering från Dependabot; inget i imagen ändras.

- @humanfs/node uppdateras till 0.16.8 och åtgärdar GHSA-p498-v437-472g,
  där den rekursiva kopieringen följde symlänkade filer utanför
  källträdet. Paketet ligger under eslint-kedjan och installeras aldrig
  annat än för utveckling.
- Från och med den här versionen får varje patch från Dependabot en egen
  release, så att en ändring som landar också syns som en version.

## 4.1.2 — 2026-09-01

Beroendeuppdatering från Dependabots månadssvep; inga funktionella
ändringar.

- Sjutton minor- och patchuppdateringar av npm-paket, bland dem next och
  eslint-config-next på 16.3.2.
- Den låsta digesten för node-basimagen och CodeQL-actions följer med
  sina grupper.
- ESLint 10 föreslogs och avböjdes igen: eslint-plugin-react 7.37.5 går
  fortfarande sönder på den, vilket följs i
  jsx-eslint/eslint-plugin-react#3977.

## 4.1.1 — 2026-08-22

Inget i imagen ändras; den här releasen gäller bara de workflows som
bygger den.

- Varje låst action kommenterar nu den exakta release som dess commit hör
  till i stället för major-versionen. En major-tagg flyttas, så `# v4`
  slutade stämma i samma stund som uppströms taggade om den, och
  granskningen av workflows hittade åtta avvikelser i låsningar som ingen
  hade rört.
- Dependabot väntar en vecka innan den föreslår en uppdatering. En release
  som dras tillbaka eller visar sig vara komprometterad plockas oftast
  bort långt inom det fönstret.
- `docker/setup-buildx-action` uppdateras till v4.3.0, den release som den
  privata varianten redan körde: de två repona delar Dependabot-konfiguration
  men råkade köra den med en dags mellanrum.

## 4.1.0 — 2026-08-21

- Alla MCP-verktyg listas i `tools/list`. Åtta verktyg (uppdatera kund,
  uppdatera faktura, företagsinställningar, fakturaleveranser,
  återkommande scheman) var markerade som bara sökbara och utelämnades ur
  listan; Claude Desktop anropar bara verktyg som den fått där, så de
  svarade "Tool not found" trots att servern tog emot anropet. Hela
  katalogen ryms i kontextbudgeten med god marginal.
- Användarmenyn visar den version som körs på sista raden.
  Release-imagerna bär sin tagg (`4.1.0`); `:latest`-byggen från main bär
  `main-<sha>`, så en server kan alltid säga vilken commit den kör.
- Discord-länken och dialogen "Kontakta support" är borta från
  användarmenyn, mobilmenyn, hjälpsidan, kontots raderingsavsnitt, de
  tomma vyerna och felsidorna. Dialogen mejlade uppströms supportadress
  via en e-posttjänst som en LAN-installation aldrig konfigurerar. Routen
  `/api/support/contact` försvinner med den.
- Omdirigeringen från den gamla värden i `next.config.ts` är borta; den
  aktiverades bara på en https-värd som inte var app.gnubok.se.

## 4.0.0 — 2026-08-20

Inloggnings- och delningslagret skärs ned till det en LAN-installation
med en enda användare faktiskt använder: e-post och lösenord, inget mer.
Omkring 9 800 rader försvinner ur koden.

- Inloggning med Google är borta. Självhostade installationer har aldrig
  haft leverantören konfigurerad, så knappen var redan släckt; nu är
  koden bakom den också borta.
- Återställning av lösenord via e-post är borta. Stacken levereras utan
  SMTP och GoTrue bekräftar registreringar automatiskt, så inget mejl
  lämnade någonsin systemet: återställningssidan, auth-callbacken som tog
  emot återställnings- och bekräftelselänkar och skärmarna som bad dig
  kolla e-posten gick inte att nå. Ett glömt lösenord återställs i stället
  via GoTrues admin-API; receptet står under Felsökning i SELF-HOSTING.
- MFA-maskineriet är borta. Det gick aldrig att slå på självhostat
  (flaggan är inbakad i imagen), men sidorna för registrering och
  verifiering och kontrollerna av säkerhetsnivå kördes på varje
  anropsväg.
- Inbjudningar, team och stöd för flera företag är borta. Utan e-post
  kunde inbjudningsflödet bara dela ut länkar för hand, och en ensam
  användare har ingen att bjuda in och inget andra företag att byta
  till. Företagsväxlaren, panelen för medlemmar och teaminställningarna
  försvinner med dem.
- BRYTANDE: migrationen tar permanent bort tabellerna
  `company_invitations`, `teams`, `team_members` och `team_invitations`,
  tillsammans med alla `team_id`-kolumner och de teambundna
  bokföringsmallarna. En installation som ändå använde inbjudningar eller
  team förlorar de uppgifterna vid uppgraderingen; installationer med en
  enda användare förlorar inget. `company_members` blir kvar, eftersom
  varje policy för radnivåsäkerhet slås upp genom den.

## 3.2.0 — 2026-08-20

- Lösenordspolicyn är en längdregel igen: minst sex tecken, och inga krav
  på blandade versaler och gemener, en siffra eller ett specialtecken.
  Sex motsvarar GoTrues egen undre gräns, så formuläret och auth-tjänsten
  kan inte längre vara oense, och vändan med "svagt lösenord" är borta.
  Firmabok betjänar en användare över ren HTTP på det lokala nätet, där
  en lång lista med sammansättningsregler ger lite och mest får folk att
  skriva lösenordet på en lapp.
- Regeln fanns i fem kopior: registrering, återställning av lösenord, val
  av lösenord, säkerhetspanelen i inställningarna och kontots route för
  lösenord. Nu finns den i `lib/auth/password-policy.ts`, som formulärens
  `minLength`-attribut och båda meddelandekatalogerna läser från, så att
  kopiorna inte kan glida isär igen.

## 3.1.1 — 2026-08-20

- Installationsskriptet säger till när kärnan saknar memory cgroup.
  Raspberry Pis firmware startar med `cgroup_disable=memory`, och Compose
  struntar då i varje `mem_limit` i stacken medan `docker stats` inte
  visar något alls; det enda tecknet är en kortfattad varning per tjänst.
  SELF-HOSTING har lösningen: `cgroup_enable=memory` på den enda raden i
  `/boot/firmware/cmdline.txt`, en omstart och sedan `docker compose up
  -d --force-recreate`, eftersom containrarna behåller sin gamla
  värdkonfiguration över omstarten och gränserna inte gäller förrän de
  skapas om.
- README:n skriver ut uppdateringskommandona i stället för att hänvisa
  tillbaka till installationsavsnittet. Båda vägarna finns nu: fristående
  wget och `git pull` från en befintlig utcheckning.

## 3.1.0 — 2026-08-20

- Dependabot bevakar nu npm-trädet, de låsta GitHub Actions och
  Docker-basimagen. Låsningen till SHA:er och digester är avsiktlig, men
  de raderna flyttar sig aldrig av sig själva, och en grupperad pull
  request per ekosystem och månad är det som hindrar dem från att tyst
  bli inaktuella.
- Containerns basimage går från node 22 till node 26, både i byggsteget
  och i körsteget.
- Den första månadens uppdateringar landar: 34 minor- och
  patchuppdateringar i npm-trädet (next 16.2.12 till 16.3.1, react och
  react-dom 19.2.7 till 19.2.8, Radix-paketen, pg, recharts,
  react-hook-form och resten), fem låsta actions lyfta till nya SHA:er
  och @types/node och framer-motion till sina nästa major-versioner.
  Inget i applikationens beteende ändras.
- js-yaml uppdateras till 5.3, som tar bort standardexporten. Inläsaren av
  mallpaketen importerar i stället namnrymden, och @types/js-yaml
  försvinner: paketet levererar nu sina egna typer, och de gamla
  deklarerade fortfarande den standardexport som körmiljön inte längre
  har.

## 3.0.4 — 2026-08-18

- js-yaml och nanoid lyfts ur två sårbarhetsrapporter som den dagliga
  skanningen flaggar som åtgärdbara: js-yaml 4.1.1 till 4.3.1
  (CVE-2026-59869 och GHSA-5p4m-2wfm-xmqj) och nanoid 3.3.16 till 3.3.18
  (CVE-2026-67213). Inget i applikationens beteende ändras.
- Testet av främmande nycklar godtar Postgres 18:s formulering. Det
  matchade feltexten, och 18 säger "violates RESTRICT setting of foreign
  key constraint" där tidigare versioner sa "violates foreign key
  constraint".

## 3.0.3 — 2026-08-17

- Varje migration och raden som registrerar den körs nu i en och samma
  transaktion. De var två separata `psql`-anrop, så en körning som
  avbröts mellan dem lämnade migrationen genomförd men oregistrerad, och
  eftersom SQL:en inte är idempotent misslyckades varje senare start på
  objekt som redan fanns, utan någon väg ut. En migration som misslyckas
  halvvägs rullas i stället tillbaka helt.
- Databas-, migrations-, auth- och REST-tjänsterna får samma
  `no-new-privileges`-skydd som resten av stacken redan hade.

## 3.0.2 — 2026-08-17

- Dokumentation: stdio-bryggan för MCP är `npx gnubok-mcp`. README:n
  pekade på `accounted-mcp`, som aldrig publicerades; arkitekturanteckningarna
  och bryggpaketets egen README sa samma sak och är också rättade.
- Uppdateringar bygger om cron-sidovagnen: `docker compose pull` hoppar
  över tjänster som bara byggs, så ändringar i den nådde aldrig befintliga
  installationer. Installationsskriptet vägrar också `lock` utan `.env`,
  påpekar när uppdateringsadressen skiljer sig från `DOMAIN`, och
  receptet för bygge från källa fungerar på en ny maskin.
- Docker Hub-spegeln bär bara `latest` och semver-taggarna, och varje
  speglad taggs index byggs om från plattformsimagerna, så att
  attesteringsmanifesten inte längre visas som en unknown/unknown-plattform
  på Hub. GHCR behåller det fullt attesterade indexet.
- Städning: Caddyfile från tiden före nginx och andra rester är borta,
  compose låser projektnamnet och avbryter direkt om genererade
  hemligheter saknas, och dokumentationen beskriver http-stacken som den
  är.

## 3.0.0 — 2026-08-14

- Databasen är nu den officiella `postgres`-imagen (18.2, alpine) i
  stället för Supabases. En bootstrap i tre filer skapar rollerna,
  auth-schemat som GoTrue bygger på och API-behörigheterna; allt annat
  stacken behöver följer med vanlig postgres. Imagelagren för en full
  installation krymper från över tre gigabyte till under en, och
  databasen ligger runt 45 MB i vila.
- **Brytande:** en befintlig installation kan inte ta med sig sin
  databasvolym över den här uppgraderingen. Ta en `pg_dump` på den gamla
  versionen, installera på nytt och återställ. Själva
  installationskommandona är oförändrade.
- Nya databaser skapas med svensk sortering (ICU sv-SE), så att text
  sorteras z, å, ä, ö som man väntar sig på svenska.
- De två dagliga databasjobben (förfallna leverantörsfakturor, rensning
  av personuppgifter i fakturaleveranser) körs från cron-containern som
  alla andra schemalagda jobb; databasen behöver ingen cron-extension.
- Säkerhet: funktionen som går igenom förfallna fakturor kunde anropas av
  vilken inloggad användare som helst via API:t. Nu kräver den
  service-rollen.
- Ett stort svep tog bort den vilande ytan för att bläddra bland
  extensions (MCP-servern, den enda extensionen, är orörd), döda
  schemafamiljer för integrationer som den här forken inte levererar
  (Stripe, WooCommerce, inkorgar för WhatsApp och inkommande e-post,
  migrering från andra leverantörer), rester av AI-chatten och ett
  sextiotal oanvända namnrymder för översättningar – omkring 16 000
  rader totalt. Stacken vilar runt 300 MB minne.

## 2.5.2 — 2026-08-13

- Raderade filer som inget refererade till: rester av funktioner som
  tagits bort tidigare, engångsskript för reparation och efterfyllnad
  till migrationer som körts för länge sedan, och bildfiler vars kod är
  borta. Fyra npm-paket följde med, omkring 24 MB installerade beroenden.
- Rättade två tysta problem som hittades på vägen: två tester mockade en
  modul som inte längre finns, så de testade i tysthet ingenting, och en
  fil för schemalagda jobb genererades för en uppsättning som projektet
  inte har.
- Inga funktionella ändringar.

## 2.5.1 — 2026-08-13

- Nio databasmigrationer fyllde var och en på samma skill-bibliotek från
  början, så en ny installation fick arbeta sig igenom omkring åtta
  megabyte SQL för att nå det läge som den nyaste beskriver på egen hand.
  Bara den behålls: installationer går fortare och repot blir mindre.
  Befintliga installationer påverkas inte.
- Lade till den här ändringsloggen.

## 2.5.0 — 2026-08-13

- Lagringstjänsten är borta. Appen läser och skriver nu dokument,
  logotyper och SIE-filer direkt på samma Docker-volym som förut.
  Nedladdningslänkarna är fortfarande signerade och går ut på samma sätt.
- Tog bort en oanvänd webhook-modul ur databasuppsättningen.
- Raderade död kod: ett gammalt namngivningsschema för filer med sina
  engångsskript, en föräldralös komponent och lagringsregler som inget
  upprätthöll.
- Stacken är nere i sex tjänster och omkring 450 MB i vila, vilket ryms
  gott på en maskin med 2 GB.

## 2.1.0 — 2026-08-13

- Tog bort realtime-tjänsten. Appen frågar nu servern efter ändringar i
  bakgrunden i stället för att hålla en websocket öppen. Dina egna
  ändringar syns fortfarande direkt; ändringar som görs någon annanstans
  (en annan flik, MCP-bryggan) syns inom en minut eller när fliken får
  fokus igen.
- Health checks körs en gång i minuten i stället för var femte sekund.
  Starten går lika fort som förut.
- Frigör ungefär 200 MB minne och nästan all processoranvändning i vila.

## 2.0.1 — 2026-08-11

- Compose-filen heter nu `docker-compose.yml`, så att vanliga
  `docker compose stop`, `logs` och `ps` fungerar i
  installationskatalogen utan extra flaggor.
- README:n förklarar hur man stoppar och avinstallerar.

## 2.0.0 — 2026-08-11

- Firmabok körs nu helt på din egen hårdvara. En compose-fil rymmer appen
  och de Supabase-tjänster den behöver bakom en liten nginx, och
  installationen på en förberedd Debian-server tar två kommandon. Ren
  HTTP på ditt eget nätverk.
- Uppdatering görs med samma två kommandon; databasmigrationerna körs av
  sig själva.
- Onboardingen utgår från enskild firma.
- Tog bort molndriftsvägen, BankID-maskineriet och ett antal oanvända
  beroenden. README:n omskriven kring det som faktiskt levereras.
- Den gamla compose-uppsättningen är borta, därav versionshoppet.

## 1.0.1 — 2026-08-09

- Gjorde licensen maskinläsbar: copyrightblocket flyttades till `NOTICE`
  och `LICENSE` är nu ren AGPL-text, så att GitHub identifierar den rätt.
  Inga kodändringar.

## 1.0.0 — 2026-08-09

- Första stabila versionen. Bokföringsmotor, moms, fakturering,
  årsbokslut och SIE-import/-export, med självhostad drift testad från
  grunden.
