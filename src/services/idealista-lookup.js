// ─── Idealista single-property lookup ──────────────────────────────────────
// Gedeelde service voor /vergelijk en /pitch

const { ApifyClient } = require('apify-client');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN || '';
const ACTOR_ID    = 'igolaizola/idealista-scraper';
const apifyClient = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;

async function lookupIdealista(url) {
  if (!apifyClient) throw new Error('Apify client niet geconfigureerd (APIFY_API_TOKEN ontbreekt)');

  const codeMatch = url.match(/\/inmueble\/(\d+)/);
  if (!codeMatch) throw new Error(`Geen propertyCode gevonden in URL: ${url}`);
  const propertyCode = codeMatch[1];

  console.log(`[Idealista-Lookup] propertyCode=${propertyCode}`);

  const run = await apifyClient.actor(ACTOR_ID).call({
    operation:       'sale',
    propertyType:    'homes',
    country:         'es',
    location:        '0-EU-ES-28-07-001-079', // required maar genegeerd bij propertyCodes
    propertyCodes:   [propertyCode],
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  }, { timeout: 300, memory: 1024 });

  if (!run?.defaultDatasetId) return null;

  const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
  const item = items?.[0];
  if (!item) return null;

  const d        = item._details || item;
  const ubication = d.ubication          || {};
  const chars     = d.moreCharacteristics || {};

  const get = (obj, dotKey) => {
    if (obj[dotKey] !== undefined) return obj[dotKey];
    const parts = dotKey.split('.');
    let val = obj;
    for (const p of parts) { if (val == null) return null; val = val[p]; }
    return val ?? null;
  };

  const features = [];
  if (chars.swimmingPool)    features.push('pool');
  if (chars.garden)          features.push('garden');
  if (chars.terrace)         features.push('terrace');
  if (chars.airConditioning) features.push('air_conditioning');
  if (chars.lift)            features.push('elevator');
  if (chars.garage)          features.push('garage');
  if (chars.boxroom)         features.push('storage');

  return {
    ref:           propertyCode,
    url:           d.detailWebLink || d.link || `https://www.idealista.com/inmueble/${propertyCode}/`,
    price:         d.price || get(d, 'priceInfo.price.amount') || null,
    property_type: d.propertyType || null,
    town:          ubication.administrativeAreaLevel2 || null,
    province:      ubication.administrativeAreaLevel1 || null,
    beds:          chars.roomNumber    ?? null,
    baths:         chars.bathNumber    ?? null,
    built_m2:      chars.constructedArea || null,
    plot_m2:       chars.plotOfLand    || null,
    pool:          chars.swimmingPool  ?? null,
    new_build:     d.newDevelopment || (d.state === 'newDevelopment') || null,
    features,
    desc_en:       d.propertyComment  || null,
    desc_nl:       null,
  };
}

module.exports = { lookupIdealista };
