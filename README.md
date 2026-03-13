# WoningBot + NieuwbouwBot V3.0

Slimme Slack bots voor Costa Select — AI-makelaarassistenten voor Spaans vastgoed.

## Twee bots, één app

| Bot | Commando | Wat het doet |
|-----|----------|-------------|
| **WoningBot** | `/zoekwoning` | On-demand woningzoeker: AI parsed je zoekopdracht, scraped 3 portals, selecteert top 10 met fotoanalyse |
| **NieuwbouwBot** | `/nieuwbouw` | Nieuwbouw projecten-database: dagelijkse sync naar Google Sheet, stel vragen via Slack |

## WoningBot — `/zoekwoning`

### Gebruik

```
/zoekwoning villa in Estepona of Mijas, budget 500-800k, 3 slaapkamers, zwembad, modern
```

### Flow

1. Claude parsed de tekst naar harde filters + zachte criteria
2. Idealista, Fotocasa en Kyero worden parallel gescraped (incl. nieuwbouw als gevraagd)
3. Claude selecteert de top 10 met motivatie per woning
4. Claude Vision analyseert de hoofdfoto (staat, stijl, rode vlaggen)
5. Resultaten verschijnen in Slack met progressieve updates
6. Reageer in de thread om de selectie te verfijnen

### Features

- Multi-locatie: "Estepona of Mijas" of "Costa del Sol"
- Nieuwbouw-detectie: automatisch obra nueva endpoint
- Fotoanalyse: visuele beoordeling per woning
- Thread-verfijning: "Vervang nr 3, te gedateerd"
- Progressieve Slack-updates: live voortgang per stap

## NieuwbouwBot — `/nieuwbouw`

### Gebruik

```
/nieuwbouw Estepona, Marbella, Mijas
/nieuwbouw welke projecten onder 300k met 2 slaapkamers aan de Costa del Sol?
/nieuwbouw sync
/nieuwbouw stats
```

### Commando's

| Commando | Wat het doet |
|----------|-------------|
| `/nieuwbouw [locatie(s)]` | Toon alle actieve projecten in die steden |
| `/nieuwbouw [vraag]` | Claude beantwoordt vragen over de projecten-database |
| `/nieuwbouw sync` | Handmatig een database-sync triggeren |
| `/nieuwbouw stats` | Statistieken: totaal projecten, per regio, per bron |

### Dagelijkse sync

De bot scraped automatisch elke dag om 06:00 CET alle nieuwbouwprojecten van Idealista, Fotocasa en Kyero voor alle Costa Select regio's (30+ steden). Resultaten worden geschreven naar een Google Sheet.

### Google Sheet structuur

| Kolom | Inhoud |
|-------|--------|
| Project Naam | Naam van het nieuwbouwproject |
| Ontwikkelaar | Developer/promotor |
| Regio | Costa del Sol, Costa Blanca North/South, Valencia |
| Locatie | Stad |
| Type | Appartement, villa, townhouse, etc. |
| Prijs Vanaf / Tot | Prijsrange |
| Slaapkamers | Aantal |
| m² | Oppervlakte |
| Beschrijving | Korte beschrijving |
| URL | Link naar portal |
| Bron | Idealista, Fotocasa, Kyero |
| Features | Pool, terras, zeezicht, etc. |
| Laatst/Eerst Gezien | Tracking data |
| Status | Actief / Niet meer gezien |

## Setup

### Vereiste API Keys

| Service | Variable | Waar te verkrijgen |
|---------|----------|--------------------|
| Slack Bot Token | `SLACK_BOT_TOKEN` | api.slack.com/apps |
| Slack App Token | `SLACK_APP_TOKEN` | api.slack.com/apps → Basic Information → App-Level Tokens |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | console.anthropic.com |
| Apify | `APIFY_API_TOKEN` | console.apify.com → Settings → Integrations |
| Google Sheets | `GOOGLE_SERVICE_ACCOUNT_JSON` | console.cloud.google.com → Service Accounts |
| Google Sheet ID | `GOOGLE_SHEET_ID` | Uit de Sheet URL |

### Environment variables

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...
APIFY_API_TOKEN=apify_api_...
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
GOOGLE_SHEET_ID=11vn73aTrCUmSjLfyGhTFsyzoUDX_dX53gbn1_YGwlPo
NIEUWBOUW_CRON_ENABLED=true
NIEUWBOUW_CRON_HOUR=5
```

### Slack App configuratie

Voeg deze toe aan je Slack App:

1. **Slash Commands:**
   - `/zoekwoning` — Beschrijving: "Zoek woningen in Spanje"
   - `/nieuwbouw` — Beschrijving: "Zoek nieuwbouwprojecten in Spanje"

2. **Event Subscriptions → Subscribe to bot events:**
   - `message.channels`
   - `message.groups`

3. **OAuth Scopes:**
   - `commands`, `chat:write`, `channels:history`, `groups:history`

### Deploy op Railway

1. Push code naar GitHub
2. Railway → New Project → Deploy from GitHub
3. Stel alle environment variables in (inclusief Google Sheets)
4. Railway deployt automatisch

### Handmatige sync

```bash
node src/jobs/nieuwbouw-sync.js
```

## Architectuur

```
src/
├── app.js                      # Entry point + cron scheduler
├── handlers/
│   ├── zoekwoning.js           # /zoekwoning command
│   ├── nieuwbouw.js            # /nieuwbouw command
│   └── thread-reply.js         # Thread verfijning
├── services/
│   ├── claude-parser.js        # Tekst → filters (Claude)
│   ├── claude-selector.js      # 30 → top 10 (Claude)
│   ├── claude-refiner.js       # Thread feedback (Claude)
│   ├── claude-vision.js        # Fotoanalyse (Claude Vision)
│   ├── idealista.js            # Apify Idealista scraper
│   ├── fotocasa.js             # Apify Fotocasa scraper
│   ├── kyero.js                # Apify Kyero scraper
│   ├── nieuwbouw-scraper.js    # Batch scraper voor alle regio's
│   ├── google-sheets.js        # Google Sheets API
│   └── dedup.js                # URL-based deduplicatie
├── formatters/
│   └── slack-blocks.js         # Slack Block Kit berichten
├── store/
│   └── thread-memory.js        # Thread context (persistent)
└── jobs/
    └── nieuwbouw-sync.js       # Dagelijkse sync job
```

## Kosten (geschat)

| Onderdeel | Per zoekopdracht | Per dag (sync) | Per maand |
|-----------|-----------------|----------------|-----------|
| Claude AI | ~$0.07 | ~$0.10 | ~$5 |
| Apify scrapers | ~$0.30 | ~$0.35 | ~$13 |
| Railway | — | — | $5 |
| **Totaal** | **~$0.37** | **~$0.45** | **~$23 + gebruik** |

## Ondersteunde steden

### Costa del Sol
Estepona, Marbella, Málaga, Fuengirola, Mijas, Benalmádena, Torremolinos, Nerja, Manilva, Casares, Benahavís, Rincón de la Victoria, Vélez-Málaga, Torrox, Ronda, Antequera, Coín, Alhaurín el Grande

### Costa Blanca South
Torrevieja, Orihuela (Costa), Guardamar del Segura, Rojales, Pilar de la Horadada, Santa Pola, Alicante, Elche

### Costa Blanca North
Jávea, Dénia, Moraira, Teulada, Calpe, Altea, Benidorm

### Valencia
Valencia, Gandía

## Versiegeschiedenis

- **V3.0** — NieuwbouwBot: Google Sheet database, dagelijkse sync, `/nieuwbouw` Q&A
- **V2.2** — Multi-locatie, progressieve updates, thread persistence, locatie-verrijking
- **V2.1** — Fotocasa, Kyero, nieuwbouw-fix, fotoanalyse
- **V2.0** — WoningBot V2: 3-staps AI flow, thread-verfijning
- **V1.0** — Eerste versie: Idealista + Claude

## Licentie

MIT
