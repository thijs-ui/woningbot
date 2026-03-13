/**
 * NieuwbouwBot Daily Sync Job.
 * Orchestrates: scrape all portals → deduplicate → merge with existing Sheet → update Sheet.
 *
 * Can be run:
 * - Automatically via cron (node src/jobs/nieuwbouw-sync.js)
 * - Manually via Slack command (/nieuwbouw sync)
 */

const { scrapeNewBuildProjects, normalizeToProjectRow, getRegionForCity } = require('../services/nieuwbouw-scraper');
const { readAllProjects, appendProjects, batchUpdateRows, ensureHeaders, markUnseen } = require('../services/google-sheets');

/**
 * Match a scraped listing against existing projects in the Sheet.
 * Uses project name similarity + location + price proximity.
 */
function findExistingMatch(newProject, existingProjects) {
  const newName = (newProject.project_name || '').toLowerCase().trim();
  const newLocation = (newProject.location || '').toLowerCase().trim();
  const newUrl = (newProject.url || '').toLowerCase().trim();

  for (const existing of existingProjects) {
    // Exact URL match — definitely the same
    const existingUrl = (existing.url || '').toLowerCase().trim();
    if (newUrl && existingUrl && newUrl === existingUrl) return existing;

    // Same source + similar name + same location area
    const existingName = (existing.project_name || '').toLowerCase().trim();
    const existingLocation = (existing.location || '').toLowerCase().trim();

    if (!existingName || !newName) continue;

    // Name similarity: one contains the other, or >70% word overlap
    const nameSimilar = existingName.includes(newName) || newName.includes(existingName) || wordOverlap(newName, existingName) > 0.6;

    // Location similarity: same city
    const locationSimilar = existingLocation && newLocation &&
      (existingLocation.includes(newLocation.split(',')[0]) || newLocation.includes(existingLocation.split(',')[0]));

    if (nameSimilar && locationSimilar) return existing;
  }

  return null;
}

/**
 * Calculate word overlap ratio between two strings.
 */
function wordOverlap(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/**
 * Run the full sync job.
 * @param {function} onProgress - Optional callback for progress updates
 * @returns {object} Sync results summary
 */
async function runNieuwbouwSync(onProgress = null) {
  const startTime = Date.now();
  const log = (msg) => {
    console.log(`[NieuwbouwSync] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  const results = {
    totalScraped: 0,
    newProjects: 0,
    updatedProjects: 0,
    markedUnseen: 0,
    errors: [],
  };

  try {
    // Step 1: Ensure headers exist
    log('Stap 1/5: Google Sheet voorbereiden...');
    await ensureHeaders();

    // Step 2: Read existing projects
    log('Stap 2/5: Bestaande projecten laden...');
    const existingProjects = await readAllProjects();
    log(`${existingProjects.length} bestaande projecten gevonden`);

    // Step 3: Scrape all portals
    log('Stap 3/5: Alle portals scrapen (dit kan 5-10 minuten duren)...');
    const scrapedListings = await scrapeNewBuildProjects(null, (msg) => log(`  ${msg}`));
    results.totalScraped = scrapedListings.length;
    log(`${scrapedListings.length} listings gescraped`);

    // Step 4: Normalize and merge
    log('Stap 4/5: Projecten normaliseren en samenvoegen...');
    const normalizedProjects = scrapedListings.map(normalizeToProjectRow);

    const newToAppend = [];
    const toUpdate = [];
    const seenUrls = [];
    const today = new Date().toISOString().split('T')[0];

    for (const project of normalizedProjects) {
      seenUrls.push(project.url);

      const existing = findExistingMatch(project, existingProjects);

      if (existing) {
        // Update existing: refresh last_seen, update price if changed
        const updated = { ...existing };
        updated.last_seen = today;

        // Update price range
        if (project.price_from) {
          if (!updated.price_from || project.price_from < updated.price_from) {
            updated.price_from = project.price_from;
          }
          if (!updated.price_to || project.price_from > updated.price_to) {
            updated.price_to = project.price_from;
          }
        }

        // Keep the best description (longest)
        if (project.description && project.description.length > (updated.description || '').length) {
          updated.description = project.description;
        }

        // Add source if from a different portal
        if (project.source && !updated.source.includes(project.source)) {
          updated.source = updated.source ? `${updated.source}, ${project.source}` : project.source;
        }

        // Add URL if from a different portal
        if (project.url && !updated.url.includes(project.url)) {
          updated.url = updated.url ? `${updated.url}\n${project.url}` : project.url;
        }

        updated.status = 'Actief';

        toUpdate.push({ rowNumber: existing.row_number, project: updated });
        results.updatedProjects++;
      } else {
        // New project — check if we already have it in newToAppend (dedup within batch)
        const existsInNew = newToAppend.find(p =>
          p.url === project.url ||
          (p.project_name.toLowerCase() === project.project_name.toLowerCase() &&
           p.location.toLowerCase() === project.location.toLowerCase())
        );

        if (!existsInNew) {
          project.first_seen = today;
          project.last_seen = today;
          newToAppend.push(project);
          results.newProjects++;
        }
      }
    }

    // Write updates
    if (toUpdate.length > 0) {
      await batchUpdateRows(toUpdate);
      log(`${toUpdate.length} bestaande projecten bijgewerkt`);
    }

    if (newToAppend.length > 0) {
      await appendProjects(newToAppend);
      log(`${newToAppend.length} nieuwe projecten toegevoegd`);
    }

    // Step 5: Mark unseen projects
    log('Stap 5/5: Niet meer geziene projecten markeren...');
    results.markedUnseen = await markUnseen(seenUrls);

    const duration = Math.round((Date.now() - startTime) / 1000);
    log(`Sync voltooid in ${duration}s — ${results.newProjects} nieuw, ${results.updatedProjects} bijgewerkt, ${results.markedUnseen} niet meer gezien`);

  } catch (error) {
    results.errors.push(error.message);
    log(`FOUT: ${error.message}`);
    console.error('[NieuwbouwSync] Fatal error:', error);
  }

  return results;
}

// Allow running directly from command line: node src/jobs/nieuwbouw-sync.js
if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

  runNieuwbouwSync((msg) => console.log(msg))
    .then((results) => {
      console.log('\nSync results:', JSON.stringify(results, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Sync failed:', err);
      process.exit(1);
    });
}

module.exports = { runNieuwbouwSync };
