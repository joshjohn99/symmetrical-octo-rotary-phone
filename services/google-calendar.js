const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { google } = require('googleapis');

function addMinutes(isoString, minutes) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid startISO');
  const end = new Date(d.getTime() + minutes * 60000);
  return end.toISOString();
}

function getOAuthClientFromEnv() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google Calendar env not fully configured. Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN');
  }
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

async function createEvent({ summary, description, startISO, durationMinutes = 30, timezone = 'America/Chicago' }) {
  const auth = getOAuthClientFromEnv();
  const calendar = google.calendar({ version: 'v3', auth });
  const endISO = addMinutes(startISO, durationMinutes);
  const event = {
    summary: summary || 'Appointment',
    description: description || '',
    start: { dateTime: startISO, timeZone: timezone },
    end: { dateTime: endISO, timeZone: timezone },
  };
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
    sendUpdates: 'all',
  });
  return res.data;
}

module.exports = { createEvent };
async function listUpcomingEvents({ maxResults = 10, timeMin } = {}) {
  const auth = getOAuthClientFromEnv();
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin || new Date().toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults,
  });
  return res.data.items || [];
}

async function getEventById(eventId) {
  const auth = getOAuthClientFromEnv();
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.get({ calendarId: 'primary', eventId });
  return res.data;
}

module.exports.listUpcomingEvents = listUpcomingEvents;
module.exports.getEventById = getEventById;


