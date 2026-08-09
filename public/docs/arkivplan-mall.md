# Arkivplan

**Mall for användare av erp-base**
Upprättad i enlighet med BFNAR 2013:2 punkt 8.3

---

## Instruktioner

Denna mall ska fyllas i av dig som kund och sparas som del av din systemdokumentation. Bokföringsnämndens allmänna råd (BFNAR 2013:2) kräver att varje bokföringsskyldig upprättar en arkivplan som beskriver vilken räkenskapsinformation som finns, var den förvaras, och vem som ansvarar för arkiveringen.

Fyll i de markerade fälten. Radera denna instruktionssektion innan du arkiverar dokumentet.

---

## 1. Företagsuppgifter

| Fält | Uppgift |
|---|---|
| Företagsnamn | [FÖRETAGSNAMN] |
| Organisationsnummer | [ORG-NR] |
| Företagsform | [ ] Enskild firma  [ ] Aktiebolag |
| Räkenskapsår | [STARTMÅNAD] - [SLUTMÅNAD] |
| Bokföringsmetod | [ ] Faktureringsmetoden  [ ] Kontantmetoden |
| Momsredovisningsperiod | [ ] Månadsvis  [ ] Kvartalsvis  [ ] Årsvis |
| Ansvarig för bokföringen | [NAMN, ROLL] |

## 2. Bokföringssystem

| Fält | Uppgift |
|---|---|
| Programvara | erp-base ([DOMÄN]) |
| Leverantör | [BOLAGSNAMN], org.nr [ORG-NR] |
| Lagringsplats | Molnbaserad tjänst, data lagrat inom EU (Supabase/AWS) |
| Åtkomst | Via webbläsare, inloggning med magic link (e-post) |
| Kontoplan | BAS 2025/2026 (konfigurerad i erp-base) |

## 3. Förteckning över räkenskapsinformation

Tabellen nedan anger vilken räkenskapsinformation som finns, i vilken form den förvaras, var, och arkiveringstid.

### 3.1 Löpande bokföring

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Grundbokföring (registreringsordning) | Elektronisk | erp-base databas | 7 år efter räkenskapsårets utgång |
| Huvudbokföring (systematisk ordning) | Elektronisk | erp-base databas | 7 år efter räkenskapsårets utgång |
| Verifikationer (journalposter) | Elektronisk | erp-base databas | 7 år efter räkenskapsårets utgång |

### 3.2 Verifikationsunderlag

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid | Anmärkning |
|---|---|---|---|---|
| Kundfakturor (utgående) | Elektronisk (PDF) | erp-base dokumentarkiv | 7 år | Genereras i erp-base |
| Leverantörsfakturor (inkommande) | Elektronisk (PDF/bild) | erp-base dokumentarkiv | 7 år | Uppladdade/skannade |
| Kvitton | Elektronisk (foto/PDF) | erp-base dokumentarkiv | 7 år | Fotograferade via appen |
| Bankutdrag/kontoutdrag | Elektronisk | erp-base via PSD2-koppling | 7 år | Synkroniserade via Enable Banking |
| Avtal och övriga underlag | [Elektronisk/Papper] | [erp-base / Fysisk pärm] | 7 år | [Ange var dessa förvaras] |

### 3.3 Årsbokslut och årsredovisning

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Resultaträkning | Elektronisk | erp-base rapportmodul | 7 år |
| Balansräkning | Elektronisk | erp-base rapportmodul | 7 år |
| Årsredovisning (AB) / Årsbokslut (EF) | [Elektronisk/Papper] | [erp-base / Bolagsverket / Fysisk pärm] | 7 år (10 år rekommenderat) |
| NE-bilaga (EF) | Elektronisk | erp-base rapportmodul | 7 år |
| SIE-filer (export) | Elektronisk | [Ange var exporterade filer sparas] | 7 år |

### 3.4 Skattedeklarationer och momsrapporter

| Räkenskapsinformation | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Momsdeklarationer | Elektronisk | erp-base rapportmodul + Skatteverket | 7 år |
| SRU-filer | Elektronisk | erp-base rapportmodul | 7 år |
| Inkomstdeklaration | [Elektronisk/Papper] | [Skatteverket / Egen kopia] | 7 år |

### 3.5 Systemdokumentation

| Dokument | Form | Lagringsplats | Arkiveringstid |
|---|---|---|---|
| Systemdokumentation | Elektronisk | [erp-base / Egen lagring] | Samma som den räkenskapsinformation den avser |
| Behandlingshistorik | Elektronisk | erp-base (automatiskt genererad) | Samma som den räkenskapsinformation den avser |
| Denna arkivplan | [Elektronisk/Papper] | [Ange lagringsplats] | Samma som den räkenskapsinformation den avser |

## 4. Pappersoriginal

4.1. Räkenskapsinformation som tagits emot i pappersform (kvitton, fakturor) och som har överförts till elektronisk form genom skanning eller fotografering ska bevaras i sin ursprungliga pappersform i minst tre (3) år efter utgången av det kalenderår då räkenskapsåret avslutades, i enlighet med 7 kap. 6 § BFL.

*Notering: Lagändring trädde i kraft 1 juli 2024 som möjliggör omedelbar förstöring av pappersoriginal efter överföring till elektronisk form, under förutsättning att överföringen sker på ett betryggande sätt och att inga uppgifter går förlorade. Se BFNAR 2024:1 och uppdaterad vägledning (2024-09-16) for detaljer om vilka krav som gäller vid sådan överföring.*

4.2. Dokument som tas emot elektroniskt (e-fakturor, digitala kvitton) arkiveras i elektronisk form. Inget pappersoriginal finns.

4.3. Förvaring av pappersoriginal:
- Plats: [ANGE PLATS, t.ex. kontor, bankfack]
- Ansvarig: [NAMN]

## 5. Säkerhetskopiering och redundans

5.1. erp-base sköter automatisk daglig säkerhetskopiering av databasen via Supabase-infrastrukturen.

5.2. Kunden rekommenderas att regelbundet exportera SIE4-filer och spara dessa på en separat lagringsplats som kompletterande säkerhetskopia.

Kundens kompletterande säkerhetskopiering:
- Frekvens: [t.ex. månadsvis, kvartalsvis]
- Lagringsplats: [t.ex. extern hårddisk, molnlagring]
- Ansvarig: [NAMN]

## 6. Åtkomst efter avslutad prenumeration

6.1. Vid uppsägning av erp-base-kontot har Kunden nittio (90) dagar att exportera all räkenskapsinformation i enlighet med Användarvillkoren avsnitt 8.

6.2. Räkenskapsinformation som omfattas av sjuårig arkiveringsskyldighet bevaras i skrivskyddat läge av erp-base, alternativt tillhandahålls som fullständig dataexport.

6.3. Det är Kundens ansvar att planera för dataportabilitet och säkerställa tillgång till räkenskapsinformation under hela arkiveringsperioden, oavsett om Tjänsten fortfarande används.

## 7. Geografisk lagring

7.1. All data i erp-base lagras inom EU/EES via Supabase (AWS-infrastruktur, region eu-central eller eu-west).

7.2. Viss behandling sker hos underbiträden i USA (se Personuppgiftsbiträdesavtalet, avsnitt 6.2) med stöd av EU-U.S. Data Privacy Framework eller standardavtalsklausuler.

7.3. I enlighet med 7 kap. 3a § BFL får räkenskapsinformation i elektronisk form förvaras i annat EU-land under förutsättning att detta har anmälts till Skatteverket.

**Anmälan till Skatteverket:** [ ] Har gjorts  [ ] Behöver göras  [ ] Ej tillämpligt (data lagras i Sverige)

## 8. Ansvar och kontakt

| Roll | Namn | Kontakt |
|---|---|---|
| Bokföringsansvarig | [NAMN] | [E-POST / TELEFON] |
| Extern redovisningskonsult (om tillämpligt) | [NAMN / BYRÅ] | [E-POST / TELEFON] |
| Revisor (om tillämpligt) | [NAMN / BYRÅ] | [E-POST / TELEFON] |

## 9. Uppdatering av arkivplanen

Denna arkivplan ska granskas och vid behov uppdateras minst en gång per räkenskapsår, samt vid byte av bokföringsprogram, ändring av företagsform, eller ändring av lagringsrutiner.

| Datum | Ändring | Utförd av |
|---|---|---|
| [DATUM] | Första version upprättad | [NAMN] |
| | | |

---

*Denna arkivplan uppfyller kraven i BFNAR 2013:2 punkt 8.3 och Exempel 8.1 i vägledningen. Anpassa innehållet till ditt företags specifika förhållanden. Platshållare markerade med hakparenteser ska fyllas i.*
