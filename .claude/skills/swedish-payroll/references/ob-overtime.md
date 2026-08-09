# OB-tillägg and Övertid (Unsocial Hours and Overtime)

## OB-tillägg is contractual, not statutory

No Swedish law sets OB rates. OB-tillägg (obekväm arbetstid) comes from kollektivavtal or the individual employment contract. Arbetstidslagen (1982:673) limits WHEN and HOW MUCH people may work; it says nothing about premium pay. A company without a CBA has no OB obligation unless its contracts create one, so payroll software must treat every rate, window, and divisor as configuration, never as a statutory constant.

### Common CBA window shapes (examples, always agreement-specific)

| Window | Typical span | Item type |
|---|---|---|
| Vardag kväll | weekday 18:00-22:00 (some CBAs 19:00-22:00) | ob_weekday_evening |
| Natt | 22:00-06:00 (wraps midnight) | ob_night |
| Helg | Fri/Sat evening through Sun 24:00 | ob_weekend |
| Helgdag/storhelg | actual public holidays, highest rates | ob_holiday |

### Common CBA formula shapes

Two families, both agreement-specific:

- Percent of hourly wage: OB hour paid at base hourly rate × premium percent (e.g. 20%, 50%, 70%, 100%).
- Monthly-salary divisors: OB hour paid at månadslön / divisor. Divisors like 600, 400, 300, 150 appear in white-collar CBAs, with smaller divisors (higher pay) for nights, weekends, and storhelg. These are CBA figures, not law: never hard-code them.

## Övertid vs mertid

- Övertid: time beyond ordinary full-time hours. CBAs commonly distinguish enkel övertid (weekday daytime, often ~50% premium or månadslön/94 per hour) from kvalificerad övertid (nights/weekends/holidays, often ~100% premium or månadslön/72 per hour). Divisor values vary by agreement.
- Mertid: a part-time employee's hours up to the full-time ordinary schedule. Usually plain hourly pay, sometimes a small premium; becomes övertid only past full-time hours.
- Kompensationsledighet: CBAs may allow overtime to be compensated as time off (commonly 1.5 or 2 hours per overtime hour) instead of pay.
- Contracted-away overtime: managers and salaried staff often trade övertidsersättning for higher salary and/or extra vacation days; then no overtime lines are generated at all.

## Arbetstidslagen (1982:673) limits

Limits govern hours, not pay; exceeding them is a sanction issue (sanktionsavgift via Arbetsmiljöverket), but payroll should be able to surface them:

- Ordinary working time: max 40 h/week on average (5 §).
- Allmän övertid: max 200 h/calendar year, and max 48 h per 4-week period or 50 h per calendar month (8 §).
- Extra övertid: up to 150 h/year more when special reasons exist (8 a §).
- Allmän mertid: max 200 h/calendar year for part-time employees (10 §).
- Dygnsvila: 11 consecutive hours per 24-hour period; night rest should include 24:00-05:00 (13 §).
- Veckovila: 36 consecutive hours per 7-day period (14 §).
- EU Working Time Directive backstop: max 48 h/week average over 4 months, total time including overtime.

ATL is semi-dispositive: CBAs may deviate from most limits, but only within the EU directive's frame.

## How this codebase's engine models premiums

`lib/salary/shift-premium-engine.ts` turns worked days plus configured rules into salary line items:

- A rule = day_of_week set + start/end time window + premium_percent + item_type + priority. Windows with end <= start wrap past midnight (22:00-06:00 covers both halves).
- Item types: `overtime_50`, `overtime_100`, `ob_weekday_evening`, `ob_weekend`, `ob_night`, `ob_holiday`.
- `ob_holiday` rules fire only when the worked date is an actual Swedish public holiday (calendar-driven via `isSwedishHolidayISO`); a regular Sunday is not a helgdag, a midweek Midsommarafton is.
- Every worked minute is awarded to exactly one rule: highest priority wins, ties broken by higher premium_percent, so totals never double-count.
- Amount per line = base hourly rate × hours × premium_percent / 100, rounded per the monetary rule (`Math.round(x * 100) / 100`).
- Worked-day rows without explicit start_time/end_time fall back to an assumed 08:00-17:00 shift, so pure-night or pure-weekend rules never match legacy hours-only rows. Exact shift windows are required for correct night/weekend OB.

## Payroll treatment

OB-tillägg and övertidsersättning are ordinary kontant bruttolön:

- Subject to skatteavdrag (part of the tax-table lookup base) and arbetsgivaravgifter.
- Semesterlönegrundande (raises semesterlön under procentregeln) and sjuklönegrundande (day 2-14 sjuklön includes lost shift premiums).
- PGI-grundande like any cash wage.
- AGI: reported inside kontant bruttolön (FK011) on the individual statement; there is no separate fältkod for OB or övertid.

## BAS accounts

Booked on the same wage account as base salary and differentiated by line text on the verifikat and payslip (this codebase maps all premium item types to the base wage account):

| Account | Purpose |
|---|---|
| 7010 | Löner kollektivanställda (incl. OB and overtime premiums) |
| 7210 | Löner tjänstemän (incl. OB and overtime premiums, engine default) |
| 2710 | Personalskatt (withholding on the full gross incl. premiums) |
| 2730 | Lagstadgade sociala avgifter (on the full gross incl. premiums) |
