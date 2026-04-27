/**
 * location-aliases.js — Spaanse meertalige stadsnamen aliassen.
 *
 * Spanje is meertalig: veel Costa-steden hebben twee officiële namen
 * (Spaans + regionale taal). Listings in de DB en op Idealista gebruiken
 * verschillende vormen — soms Jávea, soms Xàbia. Een gebruiker die "Javea"
 * typt mag de Xàbia-listings niet missen.
 *
 * Werking: alle keys zijn ge-normaliseerd (lowercase, accent-stripped).
 * Lookup via `expandLocations(["Javea"])` → ["Jávea", "Javea", "Xàbia", "Xabia"].
 *
 * Onbekende steden gaan ongewijzigd door — fail-soft.
 *
 * Scope v1: Costa Blanca + Costa del Sol + Valencia. Costa Brava / Baleares
 * vallen buiten Costa Select's actieve focus.
 */

// Map van normalized key (lowercase, accent-stripped) naar alle bekende varianten.
// We voegen ALLE varianten toe (incl. de zoekterm zelf met juiste accenten),
// zodat de RPC's ILIKE-filter elke spelling kan matchen.
const CITY_ALIASES = {
  // ─── Comunidad Valenciana — Costa Blanca North ─────────────────────────
  // Spaanse / Valenciaanse dubbel-namen
  'javea':              ['Jávea', 'Javea', 'Xàbia', 'Xabia'],
  'xabia':              ['Jávea', 'Javea', 'Xàbia', 'Xabia'],
  'calpe':              ['Calpe', 'Calp'],
  'calp':               ['Calpe', 'Calp'],
  'denia':              ['Dénia', 'Denia'],
  'gandia':             ['Gandía', 'Gandia'],
  'altea':              ['Altea'],
  'benidorm':           ['Benidorm'],
  'moraira':            ['Moraira', 'Teulada'], // Moraira is wijk van gemeente Teulada
  'teulada':            ['Moraira', 'Teulada'],
  'benitachell':        ['Benitachell', 'El Poble Nou de Benitatxell', 'Benitatxell'],
  'benitatxell':        ['Benitachell', 'El Poble Nou de Benitatxell', 'Benitatxell'],
  'el campello':        ['El Campello', 'Campello'],
  'campello':           ['El Campello', 'Campello'],
  'pego':               ['Pego'],
  'ondara':             ['Ondara'],
  'oliva':              ['Oliva'],

  // ─── Comunidad Valenciana — Costa Blanca South ─────────────────────────
  'alicante':           ['Alicante', 'Alacant'],
  'alacant':            ['Alicante', 'Alacant'],
  'torrevieja':         ['Torrevieja'],
  'orihuela':           ['Orihuela'],
  'orihuela costa':     ['Orihuela', 'Orihuela Costa'],
  'guardamar':          ['Guardamar', 'Guardamar del Segura'],
  'guardamar del segura': ['Guardamar', 'Guardamar del Segura'],
  'santa pola':         ['Santa Pola'],
  'pilar de la horadada': ['Pilar de la Horadada'],

  // ─── Comunidad Valenciana — Valencia & Castellón ───────────────────────
  'valencia':           ['Valencia', 'València'],
  'cullera':            ['Cullera'],
  'castellon':          ['Castellón', 'Castelló', 'Castellon'],
  'castello':           ['Castellón', 'Castelló', 'Castellon'],
  'castellon de la plana': ['Castellón', 'Castellón de la Plana', 'Castelló de la Plana'],

  // ─── Andalucía — Costa del Sol ─────────────────────────────────────────
  // Geen taal-aliassen, alleen accent-varianten
  'malaga':             ['Málaga', 'Malaga'],
  'marbella':           ['Marbella'],
  'estepona':           ['Estepona'],
  'benahavis':          ['Benahavís', 'Benahavis'],
  'mijas':              ['Mijas'],
  'fuengirola':         ['Fuengirola'],
  'benalmadena':        ['Benalmádena', 'Benalmadena'],
  'nerja':              ['Nerja'],
  'manilva':            ['Manilva'],
  'casares':            ['Casares'],
  'torremolinos':       ['Torremolinos'],
  'almeria':            ['Almería', 'Almeria'],
  'cadiz':              ['Cádiz', 'Cadiz'],

  // ─── Catalunya — Costa Brava (provincie Girona) ────────────────────────
  'gerona':             ['Gerona', 'Girona'],
  'girona':             ['Gerona', 'Girona'],
  'tossa de mar':       ['Tossa de Mar'],
  'lloret de mar':      ['Lloret de Mar'],
  'blanes':             ['Blanes'],
  'sant feliu de guixols': ['Sant Feliu de Guíxols', 'San Feliu de Guíxols', 'Sant Feliu de Guixols'],
  'san feliu de guixols':  ['Sant Feliu de Guíxols', 'San Feliu de Guíxols', 'Sant Feliu de Guixols'],
  'platja d aro':       ["Platja d'Aro", 'Playa de Aro', 'Platja dAro'],
  'playa de aro':       ["Platja d'Aro", 'Playa de Aro', 'Platja dAro'],
  's agaro':            ["S'Agaró", 'S Agaro', 'SAgaro'],
  'begur':              ['Begur'],
  'palafrugell':        ['Palafrugell'],
  'calella de palafrugell': ['Calella de Palafrugell'],
  'pals':               ['Pals'],
  'l escala':           ["L'Escala", 'La Escala', 'L Escala'],
  'la escala':          ["L'Escala", 'La Escala', 'L Escala'],
  'roses':              ['Roses'],
  'cadaques':           ['Cadaqués', 'Cadaques'],
  'empuriabrava':       ['Empuriabrava'],
  'castello d empuries': ["Castelló d'Empúries", 'Castellón de Ampurias', 'Castello dEmpuries'],
  'castellon de ampurias': ["Castelló d'Empúries", 'Castellón de Ampurias', 'Castello dEmpuries'],
  'l estartit':         ["L'Estartit", 'Estartit', 'L Estartit'],
  'estartit':           ["L'Estartit", 'Estartit', 'L Estartit'],
  'torroella de montgri': ['Torroella de Montgrí', 'Torroella de Montgri'],
  'calonge':            ['Calonge'],

  // ─── Catalunya — Costa Dorada / Costa Daurada (provincie Tarragona) ────
  'tarragona':          ['Tarragona'],
  'sitges':             ['Sitges'],
  'vilanova i la geltru': ['Vilanova i la Geltrú', 'Villanueva y Geltrú', 'Vilanova', 'Vilanova i la Geltru'],
  'vilanova':           ['Vilanova i la Geltrú', 'Vilanova', 'Vilanova i la Geltru'],
  'villanueva y geltru': ['Vilanova i la Geltrú', 'Villanueva y Geltrú', 'Vilanova', 'Vilanova i la Geltru'],
  'calafell':           ['Calafell'],
  'cunit':              ['Cunit'],
  'salou':              ['Salou'],
  'cambrils':           ['Cambrils'],
  'la pineda':          ['La Pineda'],
  'mont-roig del camp': ['Mont-roig del Camp', 'Montroig del Camp', 'Montroig'],
  'mont roig del camp': ['Mont-roig del Camp', 'Montroig del Camp', 'Montroig'],
  'montroig':           ['Mont-roig del Camp', 'Montroig del Camp', 'Montroig'],
  'l ametlla de mar':   ["L'Ametlla de Mar", 'La Ametlla de Mar', 'L Ametlla de Mar'],
  'la ametlla de mar':  ["L'Ametlla de Mar", 'La Ametlla de Mar', 'L Ametlla de Mar'],
  'l hospitalet de l infant': ["L'Hospitalet de l'Infant", 'Hospitalet del Infante', 'L Hospitalet de l Infant'],
  'hospitalet del infante':   ["L'Hospitalet de l'Infant", 'Hospitalet del Infante', 'L Hospitalet de l Infant'],
  'miami platja':       ['Miami Platja', 'Miami Playa'],
  'miami playa':        ['Miami Platja', 'Miami Playa'],
  'torredembarra':      ['Torredembarra'],
  'l ampolla':          ["L'Ampolla", 'La Ampolla', 'L Ampolla'],
  'la ampolla':         ["L'Ampolla", 'La Ampolla', 'L Ampolla'],
  'deltebre':           ['Deltebre'],
};

/**
 * Normaliseer een locatie-string voor lookup: lowercase + strip accents.
 */
function normalizeKey(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Expandeer elke locatie naar al z'n bekende varianten. Onbekende steden
 * blijven ongewijzigd (fail-soft). Output bevat geen duplicaten.
 *
 * @param {string[]} locations
 * @returns {string[]}
 */
function expandLocations(locations) {
  if (!Array.isArray(locations)) return locations;

  const expanded = new Set();
  for (const loc of locations) {
    if (!loc || typeof loc !== 'string') continue;
    const key = normalizeKey(loc);
    const aliases = CITY_ALIASES[key];
    if (aliases) {
      for (const a of aliases) expanded.add(a);
    } else {
      expanded.add(loc.trim());
    }
  }

  return [...expanded];
}

/**
 * Check of we een bepaalde locatie kennen (debug/test helper).
 */
function isKnownLocation(loc) {
  return Boolean(CITY_ALIASES[normalizeKey(loc)]);
}

module.exports = {
  expandLocations,
  isKnownLocation,
  CITY_ALIASES,
};
