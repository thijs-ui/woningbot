/**
 * NieuwbouwBot Daily Sync Job V2.
 * Orchestrates: scrape Idealista obra nueva → group into projects → merge with Sheet → update.
 *
 * Can be run:
 * - Automatically via cron (node src/jobs/nieuwbouw-sync.js)
 * - Manually via Slack command (/nieuwbouw sync)
 */

const { scrapeNewBuildProjects } = require('../services/nieuwbouw-scraper');
const { readAllProjects, appendProjects, batchUpdateRows, ensureHeaders, markUnseen } = require('../services/google-sheets');

/**
 * Match a scraped project against existing projects in the Sheet.
 * Uses project name + location + developer for matching.
 */
function findExistingMatch(newProject, existingProjects) {
  const newName = (newProject.project_name || '').toLowerCase().trim();
  const newLocation = (newProject.location || '').toLowerCase().trim();
  const newUrl = (newProject.url || '').toLowerCase().trim();
  const newDev = (newProject.developer || '').toLowerCase().trim();

  for (const existing of existingProjects) {
    // Exact URL match
    const existingUrl = (existing.url || '').toLowerCase().trim();
    if (newUrl && existingUrl && newUrl === existingUrl) return existing;

    const existingName = (existing.project_name || '').toLowerCase().trim();
    const existingLocation = (existing.location || '').toLowerCase().trim();
    const existingDev = (existing.developer || '').toLowerCase().trim();

    if (!existingName || !newName) continue;

    // Name match: one contains the other, or high word overlap
    const nameSimilar = existingName.includes(newName) ||
      newName.includes(existingName) ||
      wordOverlap(newName, existingName) > 0.6;

    // Location match: same city (first part before comma)
    const newCity = newLocation.split(',')[0].trim();
    const existingCity = existingLocation.split(',')[0].trim();
    const locationSimilar = newCity && existingCity &&
      (existingCity.includes(newCity) || newCity.includes(existingCity));

    // Developer match (bonus, not required)
    const devMatch = newDev && existingDev && newDev !== 'onbekend' && existingDev !== 'onbekend' &&
      (newDev.includes(existingDev) || existingDev.includes(newDev));

    // Match if name + location similar, or name + developer match
    if (nameSimilar && (locationSimilar || devMatch)) return existing;
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
    projectsFound: 0,
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

    // Step 3: Scrape all cities (Idealista obra nueva only)
    log('Stap 3/5: Idealista obra nueva scrapen (dit kan 5-10 minuten duren)...');
    const projectRows = await scrapeNewBuildProjects(null, (msg) => log(`  ${msg}`));
    results.totalScraped = projectRows.length;
    results.projectsFound = projectRows.length;
    log(`${projectRows.length} projecten gevonden`);

    if (projectRows.length === 0) {
      log('Geen projecten gevonden. Controleer Apify credits en verbinding.');
      results.errors.push('Geen projecten gescraped');
      return results;
    }

    // Step 4: Merge with existing data
    log('Stap 4/5: Samenvoegen met bestaande data...');
    const newToAppend = [];
    const toUpdate = [];
    const seenUrls = [];
    const today = new Date().toISOString().split('T')[0];

    for (const project of projectRows) {
      seenUrls.push(project.url);

      const existing = findExistingMatch(project, existingProjects);

      if (existing) {
        // Update existing project
        const updated = { ...existing };
        updated.last_seen = today;
        updated.status = 'Actief';

        // Update price range (expand if needed)
        if (project.price_from) {
          if (!updated.price_from || project.price_from < updated.price_from) {
            updated.price_from = project.price_from;
          }
        }
        if (project.price_to) {
          if (!updated.price_to || project.price_to > updated.price_to) {
            updated.price_to = project.price_to;
          }
        }

        // Keep the best description (longest)
        if (project.description && project.description.length > (updated.description || '').length) {
          updated.description = project.description;
        }

        // Update bedrooms if we have more info
        if (project.bedrooms && (!updated.bedrooms || project.bedrooms.length > updated.bedrooms.length)) {
          updated.bedrooms = project.bedrooms;
        }

        // Update property type if we have more info
        if (project.property_type && (!updated.property_type || project.property_type.length > updated.property_type.length)) {
          updated.property_type = project.property_type;
        }

        // Update features if we have more
        if (project.features && project.features.length > (updated.features || '').length) {
          updated.features = project.features;
        }

        // Update region if it was "Overig" and we now have a real one
        if (updated.region === 'Overig' && project.region !== 'Overig') {
          updated.region = project.region;
        }

        toUpdate.push({ rowNumber: existing.row_number, project: updated });
        results.updatedProjects++;
      } else {
        // New project — dedup within batch
        const existsInNew = newToAppend.find(p =>
          p.url === project.url ||
          (p.project_name.toLowerCase() === project.project_name.toLowerCase() &&
           p.location.toLowerCase().split(',')[0] === project.location.toLowerCase().split(',')[0])
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
    log(`Sync voltooid in ${duration}s — ${results.projectsFound} projecten gevonden, ${results.newProjects} nieuw, ${results.updatedProjects} bijgewerkt, ${results.markedUnseen} niet meer gezien`);

  } catch (error) {
    results.errors.push(error.message);
    log(`FOUT: ${error.message}`);
    console.error('[NieuwbouwSync] Fatal error:', error);
  }

  return results;
}

// Allow running directly from command line
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
