# MCP-verktygens kända begränsningar

MCP-servern bokför med samma motor som webben, men flera verktyg tar
emot färre uppgifter än motsvarande dialog och klarar därför inte alla
fall. Här står det som gäller betalningar och krediteringar, och hur
samma sak görs i webben. Allt som inte nämns fungerar likadant i båda.

## Markera kundfaktura som betald

`gnubok_mark_invoice_as_paid` tar bara emot fakturan och ett
betalningsdatum och bokför alltid hela det återstående beloppet med de
rader systemet själv tar fram. Det innebär:

- **Inget belopp och inga egna rader.** Fakturan måste ha status
  skickad eller förfallen. En delbetald faktura nekas, och del- eller
  överbetalningar går inte att registrera (se nästa avsnitt).
- **Ingen öresavrundning.** 1930 debiteras fakturans exakta belopp,
  t.ex. 1 234,56 kr, även när kunden har betalat det avrundade "Att
  betala" på 1 235 kr. Betalningsdialogen i webben föreslår det
  avrundade beloppet och bokför skillnaden på 3740. Är betalningen
  redan bokförd via MCP läggs skillnaden in som en egen verifikation,
  1930 mot 3740.
- **Utländsk valuta bokförs till fakturans kurs**, utan kursdifferens.
  I webben kan raderna justeras innan de bokförs, men rader som
  sammanlagt överstiger det återstående beloppet räknat i fakturans
  kurs nekas. En kursvinst får därför bokföras som en egen verifikation.
- **Datumet sätts när förslaget läggs.** Utan `payment_date` blir det
  dagens datum enligt UTC (strax efter midnatt svensk tid alltså
  gårdagens), och det ändras inte när förslaget godkänns. Ange därför
  alltid datumet.
- **Påbörjade krediteringar kontrolleras inte.** Webben nekar betalning
  av en faktura som har en kreditfaktura, även som utkast. MCP gör det
  inte.

## Delbetalning och överbetalning

Inget MCP-verktyg registrerar en delbetalning eller en överbetalning
direkt. I webben görs det i betalningsdialogen på fakturan:

- **Kundfaktura** (Markera som betald): ange beloppet i fältet
  *Inbetalt belopp*. Under kontantmetoden bokför varje inbetalning sin
  andel av intäkt och moms, och den sista tar exakt resten. Fattas
  mindre än 1 kr blir fakturan fullt betald och skillnaden bokförs på
  3740. Betalar kunden 1 kr eller mer för mycket bokförs överskottet
  under kontantmetoden som förskott från kund på 2420, utan moms. Under
  faktureringsmetoden nekas överbetalningen.
- **Leverantörsfaktura** (Markera betald): ange beloppet i fältet
  *Belopp att betala*. Registrera högst det som återstår (under
  kontantmetoden nekas ett större belopp) och bokför resten separat som
  en fordran på leverantören.

Ett undantag gäller även i webben: under kontantmetoden kan fakturor i
utländsk valuta och kundfakturor med ROT/RUT-avdrag inte delbetalas.
Ta emot hela beloppet i en betalning eller bokför betalningen manuellt
som verifikation.

Via MCP finns bara en omväg: bokför betalningen med
`gnubok_create_voucher` och koppla verifikationen till fakturan med
`gnubok_link_invoice_to_voucher`, så blir fakturan delvis betald. Under
kontantmetoden räknas andelen intäkt och moms då ut för hand, och
kopplingen kontrollerar bara beloppet som debiteras 19xx (under
faktureringsmetoden det som krediteras 1510), inte resten av
verifikationen. Makuleras eller raderas en kopplad verifikation senare
står betalningen kvar på fakturan, oavsett om det görs via MCP eller i
webben. För leverantörsfakturor, se nästa avsnitt.

## Leverantörsfakturor

- **Betalning:** inget MCP-verktyg markerar en leverantörsfaktura som
  betald. `gnubok_link_supplier_invoice_to_voucher` kopplar bara
  verifikationer som debiterar leverantörsskuld (244x). Det fungerar
  under faktureringsmetoden, men en betalning under kontantmetoden
  debiterar aldrig 244x. Under kontantmetoden registreras
  leverantörsbetalningar därför bara i webben, med **Markera betald**
  på leverantörsfakturan, även om `gnubok_approve_supplier_invoice`
  föreslår kopplingen som nästa steg.
- **Kreditering av delbetald faktura:** under kontantmetoden vänder
  `gnubok_credit_supplier_invoice` hela fakturans kostnad och moms,
  fast bara de betalda delarna är bokförda, och fakturan markeras som
  krediterad. Webben nekar den krediteringen. Betala resten först och
  kreditera sedan, eller bokför krediteringen manuellt som verifikation.
- En delbetald **kundfaktura** går inte att kreditera, varken via MCP
  eller i webben.

## Felmeddelanden

- MCP-verktygen svarar med vanlig text utan felkod, delvis på engelska,
  t.ex. `Invoice can only be marked as paid when status is "sent" or
  "overdue"`. Webbens felmeddelanden är på svenska.
- Ett förslag som nekas först när det godkänns bokför ingenting. Felet
  syns i notisen vid godkännandet, men under Väntande → Historik står
  förslaget sedan som *Avvisad*, samma märke som när du själv avvisar
  ett förslag.
- Svaret från `gnubok_mark_invoice_as_paid` beskriver bokningen som
  "15xx → 19xx" även under kontantmetoden, där betalningen i stället
  bokför intäkt och moms mot 1930.
