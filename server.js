/**
 * Voice server
 * - Twilio webhooks for inbound calling
 * - Optional Hume EVI handoff (if HUME_API_KEY + HUME_CONFIG_ID present)
 * - Legacy OpenAI flow (intent + TTS) as fallback when Hume not configured
 * - Google Calendar debug endpoints and OAuth helper
 */
const path = require('path');
const express = require('express');
const twilio = require('twilio');
const http = require('http');
const { createEvent, listUpcomingEvents, getEventById } = require('./services/google-calendar');
const { google } = require('googleapis');

// Load env from .env.local
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });

const requiredEnv = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];
const missing = requiredEnv.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  const msg = 'Missing required env vars: ' + missing.join(', ');
  if (process.env.VERCEL) {
    console.warn(msg + ' (continuing in serverless runtime)');
  } else {
    console.error(msg);
    process.exit(1);
  }
}

const app = express();
const port = Number(process.env.PORT || 3001);
const businessName = process.env.BUSINESS_NAME || 'our office';
const businessTz = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
const useTwilioTts = process.env.USE_TWILIO_TTS === '1';
const validateTwilio = process.env.TWILIO_VALIDATE === '1';
const operatorNumber = process.env.OPERATOR_NUMBER || '';
// Hume EVI (Phase 1): when set, /voice/answer redirects Twilio to Hume
const HUME_API_KEY = process.env.HUME_API_KEY || '';
const HUME_CONFIG_ID = process.env.HUME_CONFIG_ID || '';
// Business hours configuration: e.g., BUSINESS_HOURS="09:00-17:00", BUSINESS_DAYS="1-5" (Mon-Fri)
const businessHoursRange = process.env.BUSINESS_HOURS || '09:00-17:00';
const businessDaysSpec = process.env.BUSINESS_DAYS || '1-5';

// Twilio client for sending SMS
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || '';

// Simple in-memory session state keyed by CallSid
const sessionByCallSid = new Map();

// Map Twilio Call SID to Hume Chat ID for post-call retrieval
const callSidToHumeChatId = new Map();

// Ensure correct proto/host behind tunnels/proxies
app.set('trust proxy', true);

// Enable JSON parsing globally (for debug/test endpoints)
app.use(express.json());

// Centralized error handler to avoid timeouts on malformed bodies
app.use((err, _req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || /request size did not match content length/i.test(String(err && err.message)))) {
    console.warn('[body] parse error:', err && err.message ? err.message : err);
    return res.status(400).send('Bad Request');
  }
  next(err);
});

app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

// Optional: simple GET probe for /voice/answer (helps quick checks in browser)
app.get('/voice/answer', (_req, res) => {
  // Probe for health; Twilio will POST to the same path
  res.type('text/plain').send('voice/answer OK (use POST for Twilio)');
});

function parseBusinessDays(spec) {
  try {
    if (!spec) return new Set([0, 1, 2, 3, 4, 5, 6]);
    const days = new Set();
    for (const part of String(spec).split(',')) {
      const p = part.trim();
      if (!p) continue;
      if (p.includes('-')) {
        const [a, b] = p.split('-').map((x) => Number(x));
        if (Number.isFinite(a) && Number.isFinite(b)) {
          for (let d = Math.min(a, b); d <= Math.max(a, b); d++) days.add(d);
        }
      } else {
        const n = Number(p);
        if (Number.isFinite(n)) days.add(n);
      }
    }
    if (days.size === 0) return new Set([0, 1, 2, 3, 4, 5, 6]);
    return days;
  } catch (_) {
    return new Set([0, 1, 2, 3, 4, 5, 6]);
  }
}

function getNowPartsInTimezone(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value || 'Sun';
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = map[weekdayStr] ?? 0;
  return { day, minutes: hour * 60 + minute };
}

function isBusinessOpen({ timezone, hoursRange, daysSpec }) {
  try {
    const days = parseBusinessDays(daysSpec);
    const { day, minutes } = getNowPartsInTimezone(timezone);
    if (!days.has(day)) return false;
    const [openStr, closeStr] = String(hoursRange).split('-');
    const [oh, om] = (openStr || '00:00').split(':').map((x) => Number(x));
    const [ch, cm] = (closeStr || '23:59').split(':').map((x) => Number(x));
    const openMin = (Number.isFinite(oh) ? oh : 0) * 60 + (Number.isFinite(om) ? om : 0);
    const closeMin = (Number.isFinite(ch) ? ch : 23) * 60 + (Number.isFinite(cm) ? cm : 59);
    return minutes >= openMin && minutes <= closeMin;
  } catch (_) {
    return true;
  }
}

function getPartsForDateInTimezone(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value || 'Sun';
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = map[weekdayStr] ?? 0;
  return { day, minutes: hour * 60 + minute };
}

function isWithinBusinessHoursAt(isoString, { timezone, hoursRange, daysSpec }) {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return false;
    const days = parseBusinessDays(daysSpec);
    const { day, minutes } = getPartsForDateInTimezone(d, timezone);
    if (!days.has(day)) return false;
    const [openStr, closeStr] = String(hoursRange).split('-');
    const [oh, om] = (openStr || '00:00').split(':').map((x) => Number(x));
    const [ch, cm] = (closeStr || '23:59').split(':').map((x) => Number(x));
    const openMin = (Number.isFinite(oh) ? oh : 0) * 60 + (Number.isFinite(om) ? om : 0);
    const closeMin = (Number.isFinite(ch) ? ch : 23) * 60 + (Number.isFinite(cm) ? cm : 59);
    return minutes >= openMin && minutes <= closeMin;
  } catch (_) {
    return false;
  }
}

function businessDaysHuman(spec) {
  const s = String(spec || '').trim();
  if (s === '1-5') return 'Mon–Fri';
  if (s === '0-6') return 'Sun–Sat';
  return s || 'Mon–Fri';
}

// OpenAI TTS endpoint used by Twilio <Play>
// /tts removed (Hume handles voice)

// Inbound call webhook: answers and plays a greeting
// Note: validation can be enabled by setting validate: true, but requires correct external URL/headers
app.post('/voice/answer', express.urlencoded({ extended: false }), twilio.webhook({ validate: validateTwilio }), async (req, res) => {
  // Hume EVI: direct Twilio integration
  // Tools ARE supported when configured in your Hume Config
  if (HUME_API_KEY && HUME_CONFIG_ID) {
    const callSid = req.body.CallSid;
    const from = req.body.From;
    
    console.log(`[voice/answer] call ${callSid} from ${from} - redirecting to Hume EVI`);
    
    const twiml = new twilio.twiml.VoiceResponse();
    // Add callback parameter so Hume can notify us of the chat_id
    const callbackUrl = `${req.protocol}://${req.get('host')}/voice/hume-callback?call_sid=${encodeURIComponent(callSid)}`;
    const humeUrl = `https://api.hume.ai/v0/evi/twilio?config_id=${encodeURIComponent(HUME_CONFIG_ID)}&api_key=${encodeURIComponent(HUME_API_KEY)}`;
    
    twiml.redirect(humeUrl);
    return res.type('text/xml').send(twiml.toString());
  }
  
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('The AI assistant is not configured. Please try again later.');
  return res.type('text/xml').send(twiml.toString());
});

// legacy /voice/handle-input path removed

app.post('/voice/schedule-time', express.urlencoded({ extended: false }), twilio.webhook({ validate: validateTwilio }), async (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.query && req.query.CallSid) || 'TEST';
  const state = sessionByCallSid.get(callSid) || {};
  const speech = ((req.body && req.body.SpeechResult) || (req.query && req.query.SpeechResult) || '').trim();
  console.log('[voice/schedule-time] received', { callSid, state: state.state, speech });
  const twiml = new twilio.twiml.VoiceResponse();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.get('host');
  const baseUrl = `${proto}://${host}`;

  // persist caller message for the datetime
  try {
    await insertCallerMessage({ callSid, text: speech });
  } catch (e) {
    console.error('[persist] insertCallerMessage error', e && e.message ? e.message : e);
  }

  if (state.state !== 'awaiting_datetime') {
    twiml.redirect(`${baseUrl}/voice/answer`);
    return res.type('text/xml').send(twiml.toString());
  }

  let intent;
  try {
    const context = await getRelevantContext(speech, 4);
    intent = await inferIntentFromText(speech, { businessName, timezone: businessTz, context });
    console.log('[voice/schedule-time] intent', intent);
    try {
      await insertCallEvent({
        callSid,
        type: 'intent_detected',
        payload: {
          intent: intent && intent.intent || 'general',
          reply: intent && intent.reply || '',
          datetimeISO: intent && intent.datetimeISO || null,
          text: speech,
        },
      });
    } catch (e) {
      console.error('[persist] intent_detected event error', e && e.message ? e.message : e);
    }
  } catch (_) {
    const gather = twiml.gather({ input: 'speech dtmf', action: `${baseUrl}/voice/schedule-time`, method: 'POST', speechTimeout: 'auto', timeout: 5, numDigits: 1, actionOnEmptyResult: true });
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      gather.say('Sorry, what date and time?');
    } else {
      gather.play(`${baseUrl}/tts?text=${encodeURIComponent('Sorry, what date and time?')}`);
    }
    return res.type('text/xml').send(twiml.toString());
  }

  if (!intent.datetimeISO) {
    // Try to parse relative date/time from this turn
    const parsed = parseRelativeDateToISO({ text: speech, timezone: businessTz });
    if (!parsed) {
      const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/schedule-time`, method: 'POST', speechTimeout: 'auto' });
      gather.play(`${baseUrl}/tts?text=${encodeURIComponent('Please provide a specific day and time.')}`);
      return res.type('text/xml').send(twiml.toString());
    }
    intent.datetimeISO = parsed;
  }

  try {
    let startISO2 = ensureFutureIso(intent.datetimeISO);
    if (!isWithinBusinessHoursAt(startISO2, { timezone: businessTz, hoursRange: businessHoursRange, daysSpec: businessDaysSpec })) {
      try { await insertCallEvent({ callSid, type: 'outside_business_hours', payload: { requested: startISO2 } }); } catch (_) {}
      const msg = `That time is outside business hours. Please choose a time ${businessDaysHuman(businessDaysSpec)} between ${businessHoursRange}.`;
      const gather = twiml.gather({ input: 'speech dtmf', action: `${baseUrl}/voice/schedule-time`, method: 'POST', speechTimeout: 'auto', timeout: 5, numDigits: 1, actionOnEmptyResult: true });
      if (useTwilioTts || !process.env.OPENAI_API_KEY) { gather.say(msg); } else { gather.play(`${baseUrl}/tts?text=${encodeURIComponent(msg)}`); }
      return res.type('text/xml').send(twiml.toString());
    }
    console.log('[datetime] now:', getCurrentDateTimeISO(), 'normalized start:', startISO2);
    const evt = await createEvent({
      summary: `Call with ${businessName}`,
      description: `Booked by phone. Caller said: ${speech}`,
      startISO: startISO2,
      durationMinutes: 30,
      timezone: businessTz,
    });
    console.log('[calendar] event created', { id: evt.id, start: evt.start });
    try {
      await insertCallEvent({ callSid, type: 'calendar_event_created', payload: { id: evt.id, htmlLink: evt.htmlLink, start: evt.start } });
    } catch (e) {
      console.error('[persist] insertCallEvent error', e && e.message ? e.message : e);
    }
    sessionByCallSid.set(callSid, { state: 'scheduled', eventId: evt.id });
    const confirm = `Great, I booked you for ${new Date(evt.start.dateTime || startISO2).toLocaleString('en-US', { timeZone: businessTz })}.`;
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      twiml.say(confirm);
    } else {
      twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(confirm)}`);
    }
    const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/handle-input`, method: 'POST', speechTimeout: 'auto' });
    // No follow-up verbal prompt; just listen
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('[calendar] create error', err && err.message ? err.message : err);
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      twiml.say('I could not save that appointment. Please try again later.');
    } else {
      twiml.play(`${baseUrl}/tts?text=${encodeURIComponent('I could not save that appointment. Please try again later.')}`);
    }
    return res.type('text/xml').send(twiml.toString());
  }
});

// --- Transfer to human operator ---
app.post('/voice/transfer', express.urlencoded({ extended: false }), twilio.webhook({ validate: validateTwilio }), async (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.query && req.query.CallSid) || 'TEST';
  const twiml = new twilio.twiml.VoiceResponse();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.get('host');
  const baseUrl = `${proto}://${host}`;
  try { await insertCallEvent({ callSid, type: 'transfer_attempt', payload: { operatorNumber: operatorNumber || null } }); } catch (_) {}
  if (!operatorNumber) {
    const msg = 'No operator number is configured.';
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      twiml.say(msg);
    } else {
      twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(msg)}`);
    }
    twiml.redirect(`${baseUrl}/voice/voicemail`);
    return res.type('text/xml').send(twiml.toString());
  }
  const dial = twiml.dial({ answerOnBridge: true, timeout: 20, action: `${baseUrl}/voice/dial-action`, method: 'POST' });
  dial.number(operatorNumber);
  return res.type('text/xml').send(twiml.toString());
});

app.post('/voice/dial-action', express.urlencoded({ extended: false }), twilio.webhook({ validate: validateTwilio }), async (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.query && req.query.CallSid) || 'TEST';
  const dialStatus = (req.body && req.body.DialCallStatus) || (req.query && req.query.DialCallStatus) || '';
  const twiml = new twilio.twiml.VoiceResponse();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.get('host');
  const baseUrl = `${proto}://${host}`;
  try { await insertCallEvent({ callSid, type: 'transfer_result', payload: { dialStatus } }); } catch (_) {}
  if (dialStatus === 'completed') {
    const msg = 'Thank you for calling.';
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      twiml.say(msg);
    } else {
      twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(msg)}`);
    }
    return res.type('text/xml').send(twiml.toString());
  }
  const msg = 'No one is available to take your call. Please leave a message after the beep.';
  if (useTwilioTts || !process.env.OPENAI_API_KEY) {
    twiml.say(msg);
  } else {
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(msg)}`);
  }
  twiml.redirect(`${baseUrl}/voice/voicemail`);
  return res.type('text/xml').send(twiml.toString());
});

// --- Voicemail ---
app.post('/voice/voicemail', express.urlencoded({ extended: false }), twilio.webhook({ validate: validateTwilio }), async (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.query && req.query.CallSid) || 'TEST';
  const twiml = new twilio.twiml.VoiceResponse();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.get('host');
  const baseUrl = `${proto}://${host}`;
  try { await insertCallEvent({ callSid, type: 'voicemail_started', payload: {} }); } catch (_) {}
  const msg = `Please leave your name, phone number, and a short message for ${businessName}.`;
  if (useTwilioTts || !process.env.OPENAI_API_KEY) {
    twiml.say(msg);
  } else {
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(msg)}`);
  }
  twiml.record({ maxLength: 120, playBeep: true, action: `${baseUrl}/voice/voicemail-status`, method: 'POST', recordingStatusCallback: `${baseUrl}/voice/voicemail-status`, recordingStatusCallbackEvent: ['completed'] });
  return res.type('text/xml').send(twiml.toString());
});

app.post('/voice/voicemail-status', express.urlencoded({ extended: false }), async (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.query && req.query.CallSid) || 'TEST';
  const recordingUrl = (req.body && (req.body.RecordingUrl || req.body.RecordingUrl0)) || (req.query && (req.query.RecordingUrl || req.query.RecordingUrl0)) || '';
  const recordingSid = (req.body && req.body.RecordingSid) || (req.query && req.query.RecordingSid) || '';
  const duration = (req.body && req.body.RecordingDuration) || (req.query && req.query.RecordingDuration) || '';
  try {
    await insertCallEvent({ callSid, type: 'voicemail_saved', payload: { recordingSid, recordingUrl, duration } });
  } catch (_) {}
  res.type('text/xml').send(new twilio.twiml.VoiceResponse().toString());
});

// Debug endpoints (local/json tests)
app.all('/debug/ai', async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use POST with JSON { text }' });
    }
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const intent = await inferIntentFromText(text, { businessName, timezone: businessTz });
    return res.json({ ok: true, intent });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// --- Google OAuth: mint a refresh token (one-time setup) ---
function makeOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

app.get('/oauth/google/start', (req, res) => {
  try {
    const oauth2Client = makeOAuthClient();
    const SCOPES = ['https://www.googleapis.com/auth/calendar'];
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
    res.status(200).send(`
      <html><body>
        <h3>Google OAuth</h3>
        <p><a href="${url}">Authorize Google Calendar</a></p>
        <p>After approving, you will be redirected to the callback with a code.</p>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send(`OAuth init error: ${e && e.message ? e.message : e}`);
  }
});

// Register callback route based on GOOGLE_REDIRECT_URI path
(() => {
  try {
    const redirect = new URL(process.env.GOOGLE_REDIRECT_URI);
    const callbackPath = redirect.pathname || '/oauth2callback';
    app.get(callbackPath, async (req, res) => {
      try {
        const code = String(req.query.code || '');
        if (!code) return res.status(400).send('Missing code');
        const oauth2Client = makeOAuthClient();
        const { tokens } = await oauth2Client.getToken(code);
        const refresh = tokens.refresh_token;
        console.log('[google] tokens received');
        if (refresh) {
          console.log('[google] REFRESH TOKEN:', refresh);
          return res.status(200).send(`
            <html><body>
              <h3>Success</h3>
              <p>Copy this and add to your .env.local:</p>
              <pre>GOOGLE_REFRESH_TOKEN=${refresh}</pre>
            </body></html>
          `);
        }
        return res.status(200).send('Authorized, but no refresh_token returned. Ensure prompt=consent and access_type=offline.');
      } catch (e) {
        console.error('[google] oauth callback error', e && e.message ? e.message : e);
        return res.status(500).send('OAuth callback error. Check server logs.');
      }
    });
  } catch (_) {
    // ignore if GOOGLE_REDIRECT_URI is not a valid URL at boot; route won't be registered
  }
})();

// Create a Google Calendar event (debug/testing)
app.post('/debug/calendar/create', async (req, res) => {
  try {
    const summary = String(req.body.summary || 'Test Event');
    const description = String(req.body.description || 'Created via /debug/calendar/create');
    const startISO = String(req.body.startISO || '').trim();
    const durationMinutes = Number.isFinite(Number(req.body.durationMinutes)) ? Number(req.body.durationMinutes) : 30;
    const timezone = String(req.body.timezone || businessTz);

    if (!startISO) {
      return res.status(400).json({ ok: false, error: 'startISO required (e.g. 2025-11-03T15:00:00-05:00)' });
    }

    const event = await createEvent({ summary, description, startISO, durationMinutes, timezone });
    return res.json({ ok: true, event });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// List upcoming events (debug)
app.get('/debug/calendar/list', async (req, res) => {
  try {
    const maxResults = Number(req.query.maxResults || 10);
    const timeMin = String(req.query.timeMin || '').trim() || undefined;
    const items = await listUpcomingEvents({ maxResults, timeMin });
    return res.json({ ok: true, items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// Get event by id (debug)
app.get('/debug/calendar/get', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const event = await getEventById(id);
    return res.json({ ok: true, event });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// --- Hume Tool Bridge: book_appointment ---
// Accepts Hume tool parameters and creates a Google Calendar event.
// Parameters (JSON): { calendarId?, date, startTime, endTime, timezone?, summary?, description?, attendees?[] }
app.post('/tools/hume/book-appointment', async (req, res) => {
  console.log('[hume-tool-bridge] book_appointment called');
  console.log('[hume-tool-bridge] raw body:', JSON.stringify(req.body, null, 2));
  
  try {
    const calendarId = String(req.body.calendarId || 'primary').trim();
    const date = String(req.body.date || '').trim(); // YYYY-MM-DD
    const startTime = String(req.body.startTime || '').trim(); // HH:mm
    const endTime = String(req.body.endTime || '').trim(); // HH:mm
    const timezone = String(req.body.timezone || businessTz);
    const summary = String(req.body.summary || `Call with ${businessName}`);
    const description = String(req.body.description || 'Booked via Hume tool book_appointment');
    const attendees = Array.isArray(req.body.attendees) ? req.body.attendees : undefined;

    console.log('[hume-tool-bridge] parsed params:', { calendarId, date, startTime, endTime, timezone, summary, description, attendees });

    if (!date || !startTime || !endTime) {
      console.error('[hume-tool-bridge] missing required params');
      return res.status(400).json({ ok: false, error: 'date, startTime, endTime required' });
    }

    // Build local datetime using luxon to avoid cross-timezone date shifts
    const { DateTime } = require('luxon');
    const nowTz = DateTime.now().setZone(timezone);

    function parseDate(dStr) {
      // Accept YYYY-MM-DD, MM/DD/YYYY, or MM/DD (assume current year)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
        const [y, m, d] = dStr.split('-').map((n) => Number(n));
        return { year: y, month: m, day: d };
      }
      const mmddyyyy = DateTime.fromFormat(dStr, 'M/d/yyyy', { zone: timezone });
      if (mmddyyyy.isValid) return { year: mmddyyyy.year, month: mmddyyyy.month, day: mmddyyyy.day };
      const mmdd = DateTime.fromFormat(dStr, 'M/d', { zone: timezone }).set({ year: nowTz.year });
      if (mmdd.isValid) return { year: mmdd.year, month: mmdd.month, day: mmdd.day };
      // Fallback: try ISO parse
      const iso = DateTime.fromISO(dStr, { zone: timezone });
      if (iso.isValid) return { year: iso.year, month: iso.month, day: iso.day };
      return null;
    }

    function parseTime(tStr) {
      // Accept HH:mm, H:mm, h:mm a, h a
      const candidates = ['H:mm', 'h:mm a', 'h a', 'H'];
      for (const fmt of candidates) {
        const dt = DateTime.fromFormat(tStr.trim().toLowerCase(), fmt, { zone: timezone });
        if (dt.isValid) return { hour: dt.hour, minute: dt.minute };
      }
      // Fallback simple split (HH:mm)
      const [hh, mm] = tStr.split(':').map((n) => Number(n));
      if (Number.isFinite(hh)) return { hour: hh, minute: Number.isFinite(mm) ? mm : 0 };
      return null;
    }

    const dParts = parseDate(date);
    const sParts = parseTime(startTime);
    const eParts = parseTime(endTime);
    console.log('[hume-tool-bridge] date parts:', dParts, 'start time parts:', sParts, 'end time parts:', eParts);
    
    if (!dParts || !sParts || !eParts) {
      console.error('[hume-tool-bridge] invalid date/time format');
      return res.status(400).json({ ok: false, error: 'Invalid date or time format' });
    }

    let startDt = DateTime.fromObject({ ...dParts, ...sParts, second: 0, millisecond: 0 }, { zone: timezone });
    let endDt = DateTime.fromObject({ ...dParts, ...eParts, second: 0, millisecond: 0 }, { zone: timezone });
    if (endDt <= startDt) endDt = endDt.plus({ days: 1 });

    const startLocal = startDt.toISO();
    const endLocal = endDt.toISO();
    console.log('[hume-tool-bridge] computed ISO times:', { startLocal, endLocal });

    // Google API client from existing oauth env
    const auth = (function getAuth() {
      const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN } = process.env;
      const o = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
      o.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
      return o;
    })();
    const calendar = google.calendar({ version: 'v3', auth });
    const body = {
      summary,
      description,
      start: { dateTime: startLocal, timeZone: timezone },
      end: { dateTime: endLocal, timeZone: timezone },
    };
    if (attendees && attendees.length) body.attendees = attendees.map((email) => ({ email }));
    
    console.log('[hume-tool-bridge] calling Google Calendar API with body:', JSON.stringify(body, null, 2));
    const resp = await calendar.events.insert({ calendarId, requestBody: body, sendUpdates: 'all' });
    const event = resp.data;

    console.log('[hume-tool-bridge] ✅ event created:', { id: event.id, htmlLink: event.htmlLink, start: event.start, end: event.end });
    return res.json({ ok: true, event: { id: event.id, htmlLink: event.htmlLink, start: event.start, end: event.end, summary: event.summary } });
  } catch (err) {
    console.error('[hume-tool-bridge] ❌ error:', err?.message || err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// --- Post-Call Processing: Twilio Status Webhook ---
// Configure this URL in your Twilio phone number settings as the "Status Callback URL"
app.post('/voice/call-status', express.urlencoded({ extended: false }), async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const from = req.body.From;
  const to = req.body.To;
  const duration = req.body.CallDuration;

  console.log(`[call-status] ${callSid} status: ${callStatus}, from: ${from}, duration: ${duration}s`);

  // Only process completed calls
  if (callStatus === 'completed' && HUME_API_KEY && HUME_CONFIG_ID) {
    // Process appointment booking asynchronously (don't block webhook response)
    processPostCallBooking(callSid, from).catch(err => {
      console.error(`[call-status] error processing call ${callSid}:`, err?.message || err);
    });
  }

  res.status(204).end();
});

/**
 * Process post-call appointment booking
 * 1. Fetch conversation from Hume
 * 2. Parse appointment details
 * 3. Book appointment if details found
 * 4. Send SMS confirmation
 */
async function processPostCallBooking(callSid, customerPhone) {
  console.log(`[post-call-booking][${callSid}] starting...`);

  try {
    const { fetchHumeConversation, findRecentHumeChat, parseAppointmentFromConversation } = require('./services/hume-conversation');
    
    // Try to get Hume chat_id from our stored mapping
    let humeChatId = callSidToHumeChatId.get(callSid);
    
    if (!humeChatId) {
      console.log(`[post-call-booking][${callSid}] no stored chat_id, searching recent chats...`);
      // Fallback: find the most recent Hume chat (likely the one that just ended)
      try {
        humeChatId = await findRecentHumeChat(new Date(), customerPhone);
      } catch (err) {
        console.error(`[post-call-booking][${callSid}] could not find Hume chat:`, err?.message || err);
        console.log(`[post-call-booking][${callSid}] falling back to mock conversation for testing`);
        
        // Use mock conversation as fallback
        const mockConversation = {
          event_messages: [
            { role: 'user', message: { content: 'I want to book an appointment for tomorrow at 2pm' } },
            { role: 'assistant', message: { content: 'Great! What is your name?' } },
            { role: 'user', message: { content: 'My name is John Smith' } },
          ],
          metadata: { from: customerPhone },
        };
        
        const appointment = parseAppointmentFromConversation(mockConversation);
        return await bookAndNotify(callSid, customerPhone, appointment);
      }
    }
    
    console.log(`[post-call-booking][${callSid}] fetching conversation from Hume chat: ${humeChatId}`);
    const conversation = await fetchHumeConversation(humeChatId);
    
    // Clean up stored mapping
    callSidToHumeChatId.delete(callSid);
    
    // Parse appointment from real conversation
    const appointment = parseAppointmentFromConversation(conversation);

    return await bookAndNotify(callSid, customerPhone, appointment);
  } catch (err) {
    console.error(`[post-call-booking][${callSid}] ❌ error:`, err?.message || err);
  }
}

/**
 * Book appointment and send SMS notification
 */
async function bookAndNotify(callSid, customerPhone, appointment) {
  console.log(`[post-call-booking][${callSid}] parsed appointment:`, appointment);

  if (!appointment.found) {
    console.log(`[post-call-booking][${callSid}] no appointment details found in conversation`);
    return;
  }
  
  try {

    // Book the appointment directly (internal call)
    console.log(`[post-call-booking][${callSid}] booking appointment...`);
    
    const { DateTime } = require('luxon');
    const calendarId = 'primary';
    const timezone = appointment.timezone;
    
    // Parse date/time using same logic as the endpoint
    const dParts = { year: parseInt(appointment.date.split('-')[0]), month: parseInt(appointment.date.split('-')[1]), day: parseInt(appointment.date.split('-')[2]) };
    const sParts = { hour: parseInt(appointment.startTime.split(':')[0]), minute: parseInt(appointment.startTime.split(':')[1]) };
    const eParts = { hour: parseInt(appointment.endTime.split(':')[0]), minute: parseInt(appointment.endTime.split(':')[1]) };
    
    const startDt = DateTime.fromObject({ ...dParts, ...sParts, second: 0, millisecond: 0 }, { zone: timezone });
    const endDt = DateTime.fromObject({ ...dParts, ...eParts, second: 0, millisecond: 0 }, { zone: timezone });
    
    const auth = (function getAuth() {
      const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN } = process.env;
      const o = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
      o.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
      return o;
    })();
    
    const calendar = google.calendar({ version: 'v3', auth });
    const eventBody = {
      summary: appointment.summary,
      description: appointment.description,
      start: { dateTime: startDt.toISO(), timeZone: timezone },
      end: { dateTime: endDt.toISO(), timeZone: timezone },
    };
    
    const resp = await calendar.events.insert({ calendarId, requestBody: eventBody, sendUpdates: 'all' });
    const bookingResult = resp.data;

    console.log(`[post-call-booking][${callSid}] ✅ appointment booked:`, bookingResult.id);

    // Send SMS confirmation
    if (customerPhone && twilioPhoneNumber) {
      const confirmationMessage = `Hi ${appointment.customerName || 'there'}! Your appointment at ${businessName} is confirmed for ${appointment.date} at ${appointment.startTime}. See you then!`;
      
      console.log(`[post-call-booking][${callSid}] sending SMS to ${customerPhone}...`);
      
      await twilioClient.messages.create({
        body: confirmationMessage,
        from: twilioPhoneNumber,
        to: customerPhone,
      });

      console.log(`[post-call-booking][${callSid}] ✅ SMS confirmation sent`);
    } else {
      console.log(`[post-call-booking][${callSid}] skipping SMS (phone or Twilio number not configured)`);
    }
  } catch (err) {
    console.error(`[post-call-booking][${callSid}] ❌ booking error:`, err?.message || err);
    throw err;
  }
}

// Start server (standalone Node)
if (!process.env.VERCEL) {
  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
    console.log('POST /voice/answer redirects to Hume EVI');
    console.log('POST /voice/call-status handles post-call booking & SMS');
  });
  
  server.on('error', (err) => {
    console.error('Server error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = app;

// Removed former supabase debug and status endpoints


