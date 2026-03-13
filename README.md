# WoningBot V2 — AI-makelaarassistent voor Slack

WoningBot is een Slack bot voor vastgoedkantoren in Spanje. Een consultant typt een zoekopdracht in natuurlijke taal, en de bot zoekt, analyseert en selecteert de beste woningen — inclusief motivatie per woning. Geen simpele scraper, maar een AI-assistent die begrijpt wat een klant zoekt, ook subjectieve wensen als "moderne maar warme stijl" of "Andalusische sfeer".

## Hoe het werkt

```
/zoekwoning mijn klant zoekt een vrijstaande villa in Estepona,
budget tussen de €800.000 en €1.200.000, minimaal 3 slaapkamers,
moderne maar warme stijl, ingegraven zwembad, liefst zeezicht.
Geen urbanisatie, ze willen privacy.
```

**Stap 1 — Bevestig:** Direct antwoord in Slack ("Ik ga zoeken...").

**Stap 2 — Parse:** Claude analyseert de tekst en splitst in harde filters (prijs, locatie, type) en zachte criteria (stijl, sfeer, dealbreakers).

**Stap 3 — Scrape:** Apify doorzoekt Idealista met de harde filters. Levert circa 30 woningen op.

**Stap 4 — Selecteer:** Claude leest elke woningbeschrijving en beoordeelt ze op de zachte criteria. Selecteert maximaal 10 beste matches met motivatie per woning.

**Stap 5 — Presenteer:** Bot stuurt een geformateerd Slack-bericht met match-scores, motivaties en highlights.

**Stap 6 — Verfijn:** De consultant reageert in de thread met feedback. De bot past de selectie aan zonder opnieuw te scrapen — tenzij de filters fundamenteel veranderen (bijv. hoger budget).

## Technische stack

| Component | Technologie |
|---|---|
| Runtime | Node.js 18+ |
| Slack SDK | @slack/bolt (Socket Mode) |
| AI | Anthropic Claude claude-sonnet-4-20250514 |
| Scraping | Apify — Smart Idealista Scraper |
| Hosting | Railway.app (of elke Node.js host) |

## Projectstructuur

```
woningbot/
├── src/
│   ├── app.js                  ← Start Slack Bolt (Socket Mode)
│   ├── handlers/
│   │   ├── zoekwoning.js       ← /zoekwoning command handler
│   │   └── thread-reply.js     ← Luistert naar thread replies
│   ├── services/
│   │   ├── claude-parser.js    ← Tekst → harde filters + zachte criteria
│   │   ├── claude-selector.js  ← Woningen beoordelen + top 10
│   │   ├── claude-refiner.js   ← Feedback verwerken + herselectie
│   │   ├── idealista.js        ← Apify Smart Idealista Scraper
│   │   ├── fotocasa.js         ← Fotocasa stub (toekomstige integratie)
│   │   └── dedup.js            ← Deduplicatie logica
│   ├── formatters/
│   │   └── slack-blocks.js     ← Block Kit berichten bouwen
│   └── store/
│       └── thread-memory.js    ← In-memory opslag per thread
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Environment variables

```env
SLACK_BOT_TOKEN=xoxb-...       # Slack Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...       # Slack App-Level Token (Socket Mode)
ANTHROPIC_API_KEY=sk-ant-...   # Anthropic API key voor Claude
APIFY_API_TOKEN=apify_api_...  # Apify API token
```

## Installatie en lokaal draaien

```bash
git clone https://github.com/YOUR_USER/woningbot.git
cd woningbot
npm install
cp .env.example .env
# Vul de .env met je echte API keys
npm start
```

## Deploy op Railway.app

1. Push de code naar een GitHub repository.
2. Ga naar [railway.app](https://railway.app) en maak een nieuw project.
3. Koppel de GitHub repo.
4. Stel de environment variables in (zie hierboven).
5. Railway detecteert automatisch Node.js en draait `npm start`.
6. Socket Mode = geen publieke URL nodig.

## Slack App configuratie

De bot vereist een Slack App met de volgende instellingen:

**Socket Mode:** Ingeschakeld (App-Level Token met `connections:write` scope).

**Bot Token Scopes:** `chat:write`, `commands`.

**Event Subscriptions:** `message.channels`, `message.groups`.

**Slash Commands:** `/zoekwoning` — beschrijving: "Zoek woningen voor je klant".

## Ondersteunde locaties

De bot heeft verified Idealista location IDs voor 50+ Spaanse steden, waaronder alle Costa Select regio's.

| Regio | Steden |
|---|---|
| Costa del Sol | Estepona, Marbella, Malaga, Fuengirola, Mijas, Benalmadena, Torremolinos, Nerja, Manilva, Casares, Benahavis, Sotogrande, Rincon, Velez-Malaga, Torrox |
| Costa Blanca Zuid | Torrevieja, Orihuela, Guardamar, Rojales, Pilar de la Horadada, Santa Pola, Elche, Alicante, Murcia, Cartagena |
| Costa Blanca Noord | Javea, Denia, Moraira, Calpe, Altea, Benidorm |
| Valencia | Valencia, Gandia |
| Inland Malaga | Ronda, Antequera, Coin, Alhaurin el Grande |
| Grote steden | Madrid, Barcelona, Sevilla, Granada, Cadiz, Almeria, Palma, Ibiza |

Locaties die niet in de mapping staan worden doorgegeven als `locationName` (fallback).

## Fotocasa integratie

Fotocasa is voorbereid als stub. De handler roept `searchFotocasa()` al parallel aan Idealista aan. Om Fotocasa te activeren:

1. Kies een betrouwbare Apify actor (bijv. `igolaizola/fotocasa-scraper`).
2. Implementeer de scrape-logica in `src/services/fotocasa.js`.
3. Normaliseer de output naar hetzelfde format als Idealista.
4. De rest van de pipeline (dedup, selectie, formatting) werkt automatisch.

## Kosten per zoekopdracht

| Component | Geschatte kosten |
|---|---|
| Claude parser | circa $0.003 |
| Claude selector | circa $0.02 |
| Claude refiner (per thread-reply) | circa $0.02 |
| Apify Idealista (2 pagina's) | circa $0.25 |
| **Totaal per zoekopdracht** | **circa $0.28** |

## Error handling

De bot handelt de volgende foutscenario's af: Claude geeft geen geldige JSON (1x retry, daarna foutmelding), Apify timeout of error (meldt welke portal faalde, toont resultaten van werkende portal), 0 resultaten na scraping (melding met suggestie om criteria te verbreden), 0 resultaten na AI-selectie (melding dat geen woningen goed genoeg matchen), en Slack-berichten die te lang zijn (automatisch gesplitst in chunks van max 45 blocks).

## Licentie

MIT
