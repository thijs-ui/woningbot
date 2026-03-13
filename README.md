# WoningBot V2.1 — AI Vastgoed-assistent voor Slack

Slimme Slack bot die Spaans vastgoed doorzoekt op **Idealista**, **Fotocasa** en **Kyero**, de beste matches selecteert met AI, en foto's analyseert — alles vanuit een simpel `/zoekwoning` commando.

## Wat doet deze bot?

```
/zoekwoning nieuwbouw appartement in Estepona, 2 slaapkamers, budget 250k
```

1. **Claude AI** parsed de zoekopdracht → harde filters + zachte criteria
2. **Apify** scraped Idealista, Fotocasa en Kyero parallel
3. **Claude AI** selecteert de top 10 met motivatie per woning
4. **Claude Vision** analyseert de hoofdfoto van elke geselecteerde woning
5. **Slack** toont de resultaten met scores, motivaties en foto-analyse
6. **Thread-verfijning**: reageer in de thread om de selectie aan te passen

## Features

- **3 portals**: Idealista + Fotocasa + Kyero parallel
- **Nieuwbouw-detectie**: zoekt automatisch op resale + obra nueva als je "nieuwbouw" noemt
- **Light fotoanalyse**: Claude Vision beoordeelt de hoofdfoto op staat, stijl en rode vlaggen
- **Thread-verfijning**: "nr 4 en 7 zijn te gedateerd, vervang die" → bot selecteert vervangers + analyseert hun foto's
- **50+ steden**: alle Costa Select regio's (Costa del Sol, Costa Blanca, Valencia)
- **Deduplicatie**: dezelfde woning op meerdere portals wordt samengevoegd

## Architectuur

```
src/
├── app.js                      # Slack Bolt entry point (Socket Mode)
├── handlers/
│   ├── zoekwoning.js           # /zoekwoning command handler
│   └── thread-reply.js         # Thread feedback handler
├── services/
│   ├── claude-parser.js        # Tekst → harde filters + zachte criteria
│   ├── claude-selector.js      # 30 woningen → top 10 met motivatie
│   ├── claude-refiner.js       # Thread feedback → aangepaste selectie
│   ├── claude-vision.js        # Foto-analyse via Claude Vision
│   ├── idealista.js            # Apify Smart Idealista Scraper
│   ├── fotocasa.js             # Apify Fotocasa Scraper
│   ├── kyero.js                # Apify Kyero Scraper
│   └── dedup.js                # Deduplicatie-logica
├── formatters/
│   └── slack-blocks.js         # Slack Block Kit message builder
└── store/
    └── thread-memory.js        # In-memory thread state
```

## Vereiste API Keys

| Service | Variable | Waar te verkrijgen |
|---------|----------|--------------------|
| Slack Bot Token | `SLACK_BOT_TOKEN` | api.slack.com/apps |
| Slack App Token | `SLACK_APP_TOKEN` | api.slack.com/apps → Basic Information → App-Level Tokens |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | console.anthropic.com |
| Apify | `APIFY_API_TOKEN` | console.apify.com → Settings → Integrations |

## Installatie

### Lokaal draaien

```bash
git clone https://github.com/thijs-ui/woningbot.git
cd woningbot
npm install
cp .env.example .env
# Vul de 4 API keys in .env
npm start
```

### Deploy op Railway

1. Push code naar GitHub
2. Ga naar railway.app → New Project → Deploy from GitHub
3. Selecteer de `woningbot` repo
4. Voeg de 4 environment variables toe onder Variables
5. Railway deployt automatisch

## Kosten per zoekopdracht

| Stap | Kosten |
|------|--------|
| Claude Parser | ~$0.003 |
| Apify (3 portals) | ~$0.35-0.50 |
| Claude Selector | ~$0.06 |
| Claude Vision (10 foto's) | ~$0.03 |
| **Totaal** | **~$0.44-0.59** |
| Thread-verfijning (per keer) | ~$0.10 |

## Slack App Configuratie

Zorg dat je Slack App deze permissies heeft:

**Bot Token Scopes:**
- `chat:write`
- `commands`
- `channels:history`
- `groups:history`

**Event Subscriptions (Socket Mode):**
- `message.channels`
- `message.groups`

**Slash Commands:**
- `/zoekwoning` — Beschrijving: "Zoek woningen in Spanje"

## Ondersteunde steden

### Costa del Sol
Estepona, Marbella, Málaga, Fuengirola, Mijas, Benalmádena, Torremolinos, Nerja, Manilva, Casares, Benahavís, Rincón de la Victoria, Vélez-Málaga, Torrox, Ronda, Antequera, Coín, Alhaurín el Grande

### Costa Blanca South
Torrevieja, Orihuela (Costa), Guardamar del Segura, Rojales, Pilar de la Horadada, Santa Pola, Alicante, Elche

### Costa Blanca North
Jávea, Dénia, Moraira, Teulada, Calpe, Altea, Benidorm

### Valencia
Valencia, Gandía

## Changelog

### V2.1 (huidig)
- Fotocasa integratie via `igolaizola/fotocasa-scraper`
- Kyero integratie via `memo23/kyero-cheerio`
- Nieuwbouw-detectie: dubbele scrape (resale + obra nueva)
- Light fotoanalyse via Claude Vision
- Foto-analyse ook bij thread-verfijning (vervangende woningen)
- Status-updates in Slack tijdens het zoeken

### V2.0
- Initiële release met Idealista, Claude parsing, AI selectie, thread-verfijning

## Toekomstige uitbreidingen

- [ ] Custom Apify actors voor Lucas Fox, E&V, Resales Online
- [ ] Deep fotoanalyse (meerdere foto's per woning)
- [ ] Costa Select website integratie
- [ ] Exporteer selectie naar Pipedrive

## Licentie

MIT
