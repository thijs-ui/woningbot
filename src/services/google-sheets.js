/**
 * Google Sheets service for NieuwbouwBot.
 * Reads and writes new build project data to a shared Google Sheet.
 *
 * Sheet structure (row 1 = headers):
 * A: Project Naam | B: Ontwikkelaar | C: Regio | D: Locatie | E: Type |
 * F: Prijs Vanaf | G: Prijs Tot | H: Slaapkamers | I: m² | J: Beschrijving |
 * K: URL | L: Bron | M: Thumbnail | N: Features | O: Laatst Gezien |
 * P: Eerst Gezien | Q: Status
 */

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// Column headers matching the project row format
const HEADERS = [
  'Project Naam', 'Ontwikkelaar', 'Regio', 'Locatie', 'Type',
  'Prijs Vanaf', 'Prijs Tot', 'Slaapkamers', 'm²', 'Beschrijving',
  'URL', 'Bron', 'Thumbnail', 'Features', 'Laatst Gezien',
  'Eerst Gezien', 'Status',
];

let sheetsClient = null;
let authClient = null;

/**
 * Initialize the Google Sheets API client.
 * Uses service account credentials from environment variable or file.
 */
async function initSheetsClient() {
  if (sheetsClient) return sheetsClient;

  let credentials;

  // Try env var first (JSON string), then file path
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    const fs = require('fs');
    credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  } else {
    throw new Error('No Google service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE.');
  }

  authClient = new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });

  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  console.log('[GoogleSheets] Client initialized');
  return sheetsClient;
}

/**
 * Get the spreadsheet ID from the URL or env var.
 */
function getSpreadsheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID not set');
  return id;
}

/**
 * Ensure the sheet has headers in row 1.
 */
async function ensureHeaders() {
  const sheets = await initSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  // Check if headers exist
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'A1:Q1',
  });

  const existingHeaders = response.data.values?.[0] || [];

  if (existingHeaders.length === 0 || existingHeaders[0] !== HEADERS[0]) {
    // Write headers
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'A1:Q1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [HEADERS],
      },
    });
    console.log('[GoogleSheets] Headers written');
  }
}

/**
 * Read all existing projects from the sheet.
 * @returns {Array} Array of project objects
 */
async function readAllProjects() {
  const sheets = await initSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  await ensureHeaders();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'A2:Q5000', // Skip header row, up to 5000 projects
  });

  const rows = response.data.values || [];
  console.log(`[GoogleSheets] Read ${rows.length} existing projects`);

  return rows.map((row, index) => ({
    row_number: index + 2, // 1-indexed, +1 for header
    project_name: row[0] || '',
    developer: row[1] || '',
    region: row[2] || '',
    location: row[3] || '',
    property_type: row[4] || '',
    price_from: row[5] ? parseFloat(row[5]) : null,
    price_to: row[6] ? parseFloat(row[6]) : null,
    bedrooms: row[7] ? parseInt(row[7]) : null,
    size_m2: row[8] ? parseFloat(row[8]) : null,
    description: row[9] || '',
    url: row[10] || '',
    source: row[11] || '',
    thumbnail: row[12] || '',
    features: row[13] || '',
    last_seen: row[14] || '',
    first_seen: row[15] || '',
    status: row[16] || 'Actief',
  }));
}

/**
 * Convert a project object to a sheet row array.
 */
function projectToRow(project) {
  return [
    project.project_name || '',
    project.developer || '',
    project.region || '',
    project.location || '',
    project.property_type || '',
    project.price_from || '',
    project.price_to || '',
    project.bedrooms || '',
    project.size_m2 || '',
    project.description || '',
    project.url || '',
    project.source || '',
    project.thumbnail || '',
    project.features || '',
    project.last_seen || new Date().toISOString().split('T')[0],
    project.first_seen || new Date().toISOString().split('T')[0],
    project.status || 'Actief',
  ];
}

/**
 * Append new projects to the sheet.
 * @param {Array} projects - Array of project objects
 * @returns {number} Number of rows appended
 */
async function appendProjects(projects) {
  if (projects.length === 0) return 0;

  const sheets = await initSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  await ensureHeaders();

  const rows = projects.map(projectToRow);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'A:Q',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rows,
    },
  });

  console.log(`[GoogleSheets] Appended ${rows.length} new projects`);
  return rows.length;
}

/**
 * Update an existing project row (e.g., update last_seen date, price changes).
 * @param {number} rowNumber - 1-indexed row number
 * @param {object} updates - Fields to update
 */
async function updateProjectRow(rowNumber, updates) {
  const sheets = await initSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  // Build the row with updates
  const row = projectToRow(updates);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `A${rowNumber}:Q${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [row],
    },
  });
}

/**
 * Batch update multiple rows at once (more efficient).
 * @param {Array} updates - Array of { rowNumber, project }
 */
async function batchUpdateRows(updates) {
  if (updates.length === 0) return;

  const sheets = await initSheetsClient();
  const spreadsheetId = getSpreadsheetId();

  const data = updates.map(({ rowNumber, project }) => ({
    range: `A${rowNumber}:Q${rowNumber}`,
    values: [projectToRow(project)],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data,
    },
  });

  console.log(`[GoogleSheets] Batch updated ${updates.length} rows`);
}

/**
 * Mark projects as "Niet meer gezien" if they weren't seen in the latest scrape.
 * @param {string[]} seenUrls - URLs of projects seen in the latest scrape
 */
async function markUnseen(seenUrls) {
  const existing = await readAllProjects();
  const seenSet = new Set(seenUrls.map(u => u.toLowerCase().trim()));
  const today = new Date().toISOString().split('T')[0];

  const toUpdate = [];

  for (const project of existing) {
    const url = (project.url || '').toLowerCase().trim();
    if (url && !seenSet.has(url) && project.status === 'Actief') {
      // Only mark as unseen if it hasn't been seen for 7+ days
      const lastSeen = project.last_seen ? new Date(project.last_seen) : new Date();
      const daysSince = Math.floor((new Date() - lastSeen) / (1000 * 60 * 60 * 24));

      if (daysSince >= 7) {
        toUpdate.push({
          rowNumber: project.row_number,
          project: { ...project, status: 'Niet meer gezien' },
        });
      }
    }
  }

  if (toUpdate.length > 0) {
    await batchUpdateRows(toUpdate);
    console.log(`[GoogleSheets] Marked ${toUpdate.length} projects as 'Niet meer gezien'`);
  }

  return toUpdate.length;
}

module.exports = {
  initSheetsClient,
  ensureHeaders,
  readAllProjects,
  appendProjects,
  updateProjectRow,
  batchUpdateRows,
  markUnseen,
  HEADERS,
};
