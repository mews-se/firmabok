-- Fix corrupted BAS chart-of-accounts names in already-seeded companies.
--
-- A chart-data import bug left ~69 BAS accounts in lib/bookkeeping/bas-data/class-*.ts
-- with account_name and description corrupted by the next group's header (e.g.
-- "Utgående moms på försäljning inom EU, OSS 27 PERSONALENS SKATTER, ..."). The
-- TypeScript source has been fixed; this migration is a safety net that cleans up
-- any chart_of_accounts rows that absorbed those strings via SIE import, AI
-- account suggestions, or manual creation.
--
-- The WHERE account_name = <corrupted> guard preserves user-customized names.
-- The CASE on description protects rows where users only customized the description.
-- Idempotent: re-running matches zero rows.

with fixes (account_number, corrupted_name, fixed_name) as (
  values
    -- Class 1
    ('1099', 'Ackumulerade avskrivningar på övriga immateriella anläggningstillgångar 11 BYGGNADER OCH MARK', 'Ackumulerade avskrivningar på övriga immateriella anläggningstillgångar'),
    ('1188', 'Förskott för byggnader och mark 12 MASKINER RESPEKTIVE INVENTARIER', 'Förskott för byggnader och mark'),
    ('1299', 'Ackumulerade avskrivningar på övriga materiella anläggningstillgångar 13 FINANSIELLA ANLÄGGNINGSTILLGÅNGAR', 'Ackumulerade avskrivningar på övriga materiella anläggningstillgångar'),
    ('1389', 'Ackumulerade nedskrivningar av andra långfristiga fordringar 14 LAGER, PRODUKTER I ARBETE OCH PÅGÅENDE ARBETEN', 'Ackumulerade nedskrivningar av andra långfristiga fordringar'),
    ('1493', 'Djur som klassificeras som omsättningstillgång 15 KUNDFORDRINGAR', 'Djur som klassificeras som omsättningstillgång'),
    ('1573', 'Kundfordringar hos övriga företag som det finns ett ägarintresse i 16 ÖVRIGA KORTFRISTIGA FORDRINGAR', 'Kundfordringar hos övriga företag som det finns ett ägarintresse i'),
    ('1690', 'Fordringar för tecknat men ej inbetalt aktiekapital 17 FÖRUTBETALDA KOSTNADER OCH UPPLUPNA INTÄKTER', 'Fordringar för tecknat men ej inbetalt aktiekapital'),
    ('1790', 'Övriga förutbetalda kostnader och upplupna intäkter 18 KORTFRISTIGA PLACERINGAR', 'Övriga förutbetalda kostnader och upplupna intäkter'),
    ('1890', 'Nedskrivning av kortfristiga placeringar 19 KASSA OCH BANK', 'Nedskrivning av kortfristiga placeringar'),
    ('1990', 'Redovisningsmedel 20 EGET KAPITAL', 'Redovisningsmedel'),
    -- Class 2
    ('2099', 'Årets resultat 21 OBESKATTADE RESERVER', 'Årets resultat'),
    ('2199', 'Övriga obeskattade reserver 22 AVSÄTTNINGAR', 'Övriga obeskattade reserver'),
    ('2290', 'Övriga avsättningar 23 LÅNGFRISTIGA SKULDER', 'Övriga avsättningar'),
    ('2399', 'Övriga långfristiga skulder 24 KORTFRISTIGA SKULDER TILL KREDITINSTITUT, KUNDER OCH LEVERANTÖRER', 'Övriga långfristiga skulder'),
    ('2499', 'Andra övriga kortfristiga skulder 25 SKATTESKULDER', 'Andra övriga kortfristiga skulder'),
    ('2518', 'Betald F-skatt 26 MOMS OCH PUNKTSKATTER', 'Betald F-skatt'),
    ('2670', 'Utgående moms på försäljning inom EU, OSS 27 PERSONALENS SKATTER, AVGIFTER OCH LÖNEAVDRAG', 'Utgående moms på försäljning inom EU, OSS'),
    ('2799', 'Övriga löneavdrag 28 ÖVRIGA KORTFRISTIGA SKULDER', 'Övriga löneavdrag'),
    ('2899', 'Övriga kortfristiga skulder 29 UPPLUPNA KOSTNADER OCH FÖRUTBETALDA INTÄKTER', 'Övriga kortfristiga skulder'),
    ('2999', 'OBS-konto 30 HUVUDINTÄKTER', 'OBS-konto'),
    -- Class 3
    ('3404', 'Egna uttag, momsfria 35 FAKTURERADE KOSTNADER', 'Egna uttag, momsfria'),
    ('3590', 'Övriga fakturerade kostnader 36 RÖRELSENS SIDOINTÄKTER', 'Övriga fakturerade kostnader'),
    ('3690', 'Övriga sidointäkter 37 INTÄKTSKORRIGERINGAR', 'Övriga sidointäkter'),
    ('3790', 'Övriga intäktskorrigeringar 38 AKTIVERAT ARBETE FÖR EGEN RÄKNING', 'Övriga intäktskorrigeringar'),
    ('3870', 'Aktiverat arbete (personal) 39 ÖVRIGA RÖRELSEINTÄKTER', 'Aktiverat arbete (personal)'),
    ('3999', 'Övriga rörelseintäkter 40 INKÖP AV HANDELSVAROR', 'Övriga rörelseintäkter'),
    -- Class 4
    ('4099', 'Övriga reduktioner av inköpspriser (Handelsvaror) 42 SÅLDA HANDELSVAROR VMB', 'Övriga reduktioner av inköpspriser (Handelsvaror)'),
    ('4212', 'Sålda handelsvaror negativ VMB 25 % 43 INKÖP AV RÅVAROR OCH MATERIAL I SVERIGE (RÅVAROR OCH FÖRNÖDENHETER)', 'Sålda handelsvaror negativ VMB 25 %'),
    ('4310', 'Inköp av råvaror och material i Sverige 44 INKÖP AV RÅVAROR OCH MATERIAL, TJÄNSTER M.M. I SVERIGE, OMVÄND BETALNINGSSKYLDIGHET (RÅVAROR OCH FÖRNÖDENHETER)', 'Inköp av råvaror och material i Sverige'),
    ('4427', 'Inköp av tjänster i Sverige, omvänd betalningsskyldighet, 6 % moms 45 INKÖP AV RÅVAROR OCH MATERIAL, TJÄNSTER M.M. FRÅN UTLANDET (RÅVAROR OCH FÖRNÖDENHETER)', 'Inköp av tjänster i Sverige, omvänd betalningsskyldighet, 6 % moms'),
    ('4547', 'Import av råvaror och material, 6 % moms 46 INKÖP AV TJÄNSTER, UNDERENTREPRENADER OCH LEGOARBETEN I SVERIGE (RÅVAROR OCH FÖRNÖDENHETER)', 'Import av råvaror och material, 6 % moms'),
    ('4670', 'Inköp av legoarbeten 47 REDUKTION AV INKÖPSPRISER (RÅVAROR OCH FÖRNÖDENHETER)', 'Inköp av legoarbeten'),
    ('4739', 'Övriga reduktioner av inköpspriser (Råvaror och förnödenheter) 48 ANDRA PRODUKTIONSKOSTNADER (RÅVAROR OCH FÖRNÖDENHETER)', 'Övriga reduktioner av inköpspriser (Råvaror och förnödenheter)'),
    ('4890', 'Övriga produktionskostnader (Råvaror och förnödenheter) 49 FÖRÄNDRING AV LAGER, PRODUKTER I ARBETE OCH PÅGÅENDE ARBETEN', 'Övriga produktionskostnader (Råvaror och förnödenheter)'),
    ('4988', 'Återföring av nedskrivning av värdepapper (Handelsvaror) 50 LOKALKOSTNADER', 'Återföring av nedskrivning av värdepapper (Handelsvaror)'),
    -- Class 5
    ('5090', 'Övriga lokalkostnader 51 FASTIGHETSKOSTNADER', 'Övriga lokalkostnader'),
    ('5198', 'Övriga fastighetskostnader 52 HYRA AV ANLÄGGNINGSTILLGÅNGAR', 'Övriga fastighetskostnader'),
    ('5290', 'Hyra av övriga anläggningstillgångar, ej datorer och fordon 53 ENERGIKOSTNADER FÖR DRIFT (EJ RÅVAROR OCH FÖRNÖDENHETER)', 'Hyra av övriga anläggningstillgångar, ej datorer och fordon'),
    ('5390', 'Övriga energikostnader för drift (ej råvaror och förnödenheter) 54 FÖRBRUKNINGSINVENTARIER OCH FÖRBRUKNINGSMATERIAL', 'Övriga energikostnader för drift (ej råvaror och förnödenheter)'),
    ('5480', 'Arbetskläder och skyddsmaterial 55 REPARATION OCH UNDERHÅLL', 'Arbetskläder och skyddsmaterial'),
    ('5590', 'Övriga kostnader för reparation och underhåll 56 KOSTNADER FÖR TRANSPORTMEDEL', 'Övriga kostnader för reparation och underhåll'),
    ('5699', 'Övriga kostnader för övriga transportmedel 57 FRAKTER OCH TRANSPORTER', 'Övriga kostnader för övriga transportmedel'),
    ('5790', 'Övriga kostnader för frakter och transporter 58 RESEKOSTNADER', 'Övriga kostnader för frakter och transporter'),
    ('5890', 'Övriga resekostnader 59 REKLAM OCH PR', 'Övriga resekostnader'),
    ('5990', 'Övriga kostnader för reklam och PR 60 ÖVRIGA FÖRSÄLJNINGSKOSTNADER', 'Övriga kostnader för reklam och PR'),
    -- Class 6
    ('6090', 'Övriga försäljningskostnader 61 KONTORSMATERIAL OCH TRYCKSAKER', 'Övriga försäljningskostnader'),
    ('6150', 'Trycksaker 62 TELE, DATA OCH POST', 'Trycksaker'),
    ('6290', 'Övriga tele-, data- och postkostnader 63 FÖRETAGSFÖRSÄKRINGAR OCH ÖVRIGA RISKKOSTNADER', 'Övriga tele-, data- och postkostnader'),
    ('6392', 'Övriga riskkostnader, ej avdragsgilla 64 FÖRVALTNINGSKOSTNADER', 'Övriga riskkostnader, ej avdragsgilla'),
    ('6490', 'Övriga förvaltningskostnader 65 ÖVRIGA EXTERNA TJÄNSTER', 'Övriga förvaltningskostnader'),
    ('6590', 'Övriga externa tjänster 67 SÄRSKILT FÖR IDEELLA FÖRENINGAR OCH STIFTELSER', 'Övriga externa tjänster'),
    ('6710', 'Lämnade bidrag 68 INHYRD PERSONAL', 'Lämnade bidrag'),
    ('6890', 'Övrig inhyrd personal 69 ÖVRIGA EXTERNA KOSTNADER', 'Övrig inhyrd personal'),
    ('6999', 'Ingående moms, blandad verksamhet 70 LÖNER TILL KOLLEKTIVANSTÄLLDA', 'Ingående moms, blandad verksamhet'),
    -- Class 7
    ('7090', 'Förändring av semesterlöneskuld 72 LÖNER TILL TJÄNSTEMÄN OCH FÖRETAGSLEDARE', 'Förändring av semesterlöneskuld'),
    ('7292', 'Förändring av semesterlöneskuld till företagsledare 73 KOSTNADSERSÄTTNINGAR OCH FÖRMÅNER', 'Förändring av semesterlöneskuld till företagsledare'),
    ('7392', 'Kostnad för förmån av hushållsnära tjänster 74 PENSIONSKOSTNADER', 'Kostnad för förmån av hushållsnära tjänster'),
    ('7490', 'Övriga pensionskostnader 75 SOCIALA OCH ANDRA AVGIFTER ENLIGT LAG OCH AVTAL', 'Övriga pensionskostnader'),
    ('7590', 'Övriga sociala och andra avgifter enligt lag och avtal 76 ÖVRIGA PERSONALKOSTNADER', 'Övriga sociala och andra avgifter enligt lag och avtal'),
    ('7699', 'Övriga personalkostnader 77 NEDSKRIVNINGAR OCH ÅTERFÖRING AV NEDSKRIVNINGAR', 'Övriga personalkostnader'),
    ('7790', 'Återföring av nedskrivningar av vissa omsättningstillgångar 78 AVSKRIVNINGAR ENLIGT PLAN', 'Återföring av nedskrivningar av vissa omsättningstillgångar'),
    ('7840', 'Avskrivningar på förbättringsutgifter på annans fastighet 79 ÖVRIGA RÖRELSEKOSTNADER', 'Avskrivningar på förbättringsutgifter på annans fastighet'),
    ('7990', 'Övriga rörelsekostnader 80 RESULTAT FRÅN ANDELAR I KONCERNFÖRETAG', 'Övriga rörelsekostnader'),
    -- Class 8
    ('8087', 'Återföringar av nedskrivningar av långfristiga fordringar hos dotterföretag 81 RESULTAT FRÅN ANDELAR I INTRESSEFÖRETAG OCH GEMENSAMT STYRDA FÖRETAG SAMT ÖVRIGA FÖRETAG SOM DET FINNS ETT ÄGARINTRESSE I', 'Återföringar av nedskrivningar av långfristiga fordringar hos dotterföretag'),
    ('8187', 'Återföringar av nedskrivningar av långfristiga fordringar hos övriga företag som det finns ett ägarintresse i 82 RESULTAT FRÅN ÖVRIGA VÄRDEPAPPER OCH LÅNGFRISTIGA FORDRINGAR (ANLÄGGNINGSTILLGÅNGAR)', 'Återföringar av nedskrivningar av långfristiga fordringar hos övriga företag som det finns ett ägarintresse i'),
    ('8295', 'Orealiserade värdeförändringar på derivatinstrument 83 ÖVRIGA RÄNTEINTÄKTER OCH LIKNANDE RESULTATPOSTER', 'Orealiserade värdeförändringar på derivatinstrument'),
    ('8390', 'Övriga finansiella intäkter 84 RÄNTEKOSTNADER OCH LIKNANDE RESULTATPOSTER', 'Övriga finansiella intäkter'),
    ('8491', 'Erhållet ackord på skulder till kreditinstitut m.m. 88 BOKSLUTSDISPOSITIONER', 'Erhållet ackord på skulder till kreditinstitut m.m.'),
    ('8899', 'Övriga bokslutsdispositioner 89 SKATTER OCH ÅRETS RESULTAT', 'Övriga bokslutsdispositioner')
)
update public.chart_of_accounts coa
   set account_name = f.fixed_name,
       description  = case when coa.description = f.corrupted_name then f.fixed_name else coa.description end,
       updated_at   = now()
  from fixes f
 where coa.account_number = f.account_number
   and coa.account_name = f.corrupted_name;

notify pgrst, 'reload schema';
