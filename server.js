const path = require('path');
const express = require('express');
const twilio = require('twilio');
const { inferIntentFromText, generateGreeting, generateCallSummaryFromMessages } = require('./services/openai');
const { ensureFutureIso, getCurrentDateTimeISO } = require('./services/datetime');
const { initKnowledgeBase, getRelevantContext } = require('./services/knowledge');
const { createEvent, listUpcomingEvents, getEventById } = require('./services/google-calendar');
const { synthesizeSpeech } = require('./services/tts');
const { google } = require('googleapis');
const { upsertCall, insertCallerMessage, insertAssistantMessage, insertCallEvent, upsertCaller, getRecentCallsByPhone, getCallTranscript, buildRecentMemorySnippet, saveCallSummary } = require('./services/persistence');
const { parseRelativeDateToISO } = require('./services/date-parser');
const { supabase } = require('./services/supabase');

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
const businessTz = process.env.BUSINESS_TIMEZONE || 'America/New_York';
const useTwilioTts = process.env.USE_TWILIO_TTS === '1';
const validateTwilio = process.env.TWILIO_VALIDATE === '1';

// Simple in-memory session state keyed by CallSid
const sessionByCallSid = new Map();

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
  res.type('text/plain').send('voice/answer OK (use POST for Twilio)');
});

// OpenAI TTS endpoint used by Twilio <Play>
app.get('/tts', async (req, res) => {
  try {
    const text = String(req.query.text || '').slice(0, 1000);
    if (!text.trim()) return res.status(400).send('text required');
    const voice = (req.query.voice && String(req.query.voice)) || undefined;
    const model = (req.query.model && String(req.query.model)) || undefined;
    const { buffer, contentType } = await synthesizeSpeech(text, { voice, model });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(buffer);
  } catch (e) {
    console.error('[tts] error', e && e.message ? e.message : e);
    return res.status(500).send('tts error');
  }
});

// Inbound call webhook: answers and plays a greeting
// Note: validation can be enabled by setting validate: true, but requires correct external URL/headers
app.post('/voice/answer', express.urlencoded({ extended: false }), twilio.webhook({ validate: validateTwilio }), async (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.query && req.query.CallSid) || 'TEST';
  const from = (req.body && req.body.From) || (req.query && req.query.From) || '';
  const to = (req.body && req.body.To) || (req.query && req.query.To) || '';
  console.log('[voice/answer]', { callSid, from, to });
  sessionByCallSid.set(callSid, { state: 'start' });
  // persist call start
  try {
    await upsertCall({ callSid, from, to });
    await upsertCaller({ phone: from });
  } catch (e) {
    console.error('[persist] upsertCall error', e && e.message ? e.message : e);
  }
  const twiml = new twilio.twiml.VoiceResponse();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.get('host');
  const baseUrl = `${proto}://${host}`;
  const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/handle-input`, method: 'POST', speechTimeout: 'auto' });
  try {
    const line = await generateGreeting({ businessName, timezone: businessTz });
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      gather.say(line);
    } else {
      gather.play(`${baseUrl}/tts?text=${encodeURIComponent(line)}`);
    }
  } catch (e) {
    console.error('[voice/answer] greeting error', e && e.message ? e.message : e);
    const fallback = `Hello, you've reached ${businessName}. How can I help you today?`;
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      gather.say(fallback);
    } else {
      gather.play(`${baseUrl}/tts?text=${encodeURIComponent(fallback)}`);
    }
  }
  // Post-gather prompt and loop
  if (useTwilioTts || !process.env.OPENAI_API_KEY) {
    twiml.say('Sorry, I did not hear you.');
  } else {
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent('Sorry, I did not hear you.')}`);
  }
  twiml.redirect(`${baseUrl}/voice/answer`);
  return res.type('text/xml').send(twiml.toString());
});

app.post('/voice/handle-input', express.urlencoded({ extended: false }), twilio.webhook({ validate: validateTwilio }), async (req, res) => {
  const callSid = (req.body && req.body.CallSid) || (req.query && req.query.CallSid) || 'TEST';
  const from = (req.body && req.body.From) || (req.query && req.query.From) || '';
  const speech = ((req.body && req.body.SpeechResult) || (req.query && req.query.SpeechResult) || '').trim();
  console.log('[voice/handle-input] incoming speech', { callSid, speech });
  const twiml = new twilio.twiml.VoiceResponse();
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.get('host');
  const baseUrl = `${proto}://${host}`;

  if (!speech) {
    const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/handle-input`, method: 'POST', speechTimeout: 'auto' });
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      gather.say('I did not catch that. Please tell me how I can help.');
    } else {
      gather.play(`${baseUrl}/tts?text=${encodeURIComponent('I did not catch that. Please tell me how I can help.')}`);
    }
    return res.type('text/xml').send(twiml.toString());
  }

  // persist caller message
  try {
    await insertCallerMessage({ callSid, text: speech });
  } catch (e) {
    console.error('[persist] insertCallerMessage error', e && e.message ? e.message : e);
  }

  let intent;
  try {
    let kb = '';
    try { kb = await getRelevantContext(speech, 4); } catch (e) { if (process.env.DEBUG_AI) console.warn('[kb] error', e && e.message ? e.message : e); }
    let memory = '';
    try { memory = await buildRecentMemorySnippet({ phone: from, callId: callSid }); } catch (e) { if (process.env.DEBUG_AI) console.warn('[memory] error', e && e.message ? e.message : e); }
    const context = [memory, kb].filter(Boolean).join('\n\n');
    intent = await inferIntentFromText(speech, { businessName, timezone: businessTz, context });
    console.log('[voice/handle-input] intent', intent);
    // Persist detected intent as a call event for analytics/auditing
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
  } catch (err) {
    console.error('[voice/handle-input] intent error', err && err.message ? err.message : err);
    const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/handle-input`, method: 'POST', speechTimeout: 'auto' });
    if (useTwilioTts || !process.env.OPENAI_API_KEY) {
      gather.say('Sorry, I had trouble understanding. Please say that again.');
    } else {
      gather.play(`${baseUrl}/tts?text=${encodeURIComponent('Sorry, I had trouble understanding. Please say that again.')}`);
    }
    return res.type('text/xml').send(twiml.toString());
  }

  // persist assistant reply (pre-speak)
  try {
    await insertAssistantMessage({ callSid, text: intent.reply, intent: intent.intent, datetimeISO: intent.datetimeISO || null });
  } catch (e) {
    console.error('[persist] insertAssistantMessage error', e && e.message ? e.message : e);
  }

  if (intent.intent === 'schedule') {
    let parsedISO = intent.datetimeISO;
    if (!parsedISO) {
      // Try parsing relative phrases directly from user utterance
      parsedISO = parseRelativeDateToISO({ text: speech, timezone: businessTz });
    }
    if (parsedISO) {
      try {
        let startISO = ensureFutureIso(parsedISO);
        console.log('[datetime] now:', getCurrentDateTimeISO(), 'normalized start:', startISO);
        const evt = await createEvent({
          summary: `Call with ${businessName}`,
          description: `Booked by phone. Caller said: ${speech}`,
          startISO,
          durationMinutes: 30,
          timezone: businessTz,
        });
        console.log('[calendar] event created', { id: evt.id, start: evt.start });
        // persist calendar event
        try {
          await insertCallEvent({ callSid, type: 'calendar_event_created', payload: { id: evt.id, htmlLink: evt.htmlLink, start: evt.start } });
        } catch (e) {
          console.error('[persist] insertCallEvent error', e && e.message ? e.message : e);
        }
        twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(`Booked your appointment for ${new Date(evt.start.dateTime || startISO).toLocaleString('en-US', { timeZone: businessTz })}.`)}`);
        const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/handle-input`, method: 'POST', speechTimeout: 'auto' });
        return res.type('text/xml').send(twiml.toString());
      } catch (err) {
        console.error('[calendar] create error', err && err.message ? err.message : err);
        twiml.play(`${baseUrl}/tts?text=${encodeURIComponent('I was unable to access the calendar. Please try again later.')}`);
        return res.type('text/xml').send(twiml.toString());
      }
    }
    sessionByCallSid.set(callSid, { state: 'awaiting_datetime' });
    const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/schedule-time`, method: 'POST', speechTimeout: 'auto' });
    gather.play(`${baseUrl}/tts?text=${encodeURIComponent('What day and time would you like?')}`);
    return res.type('text/xml').send(twiml.toString());
  }

  if (useTwilioTts || !process.env.OPENAI_API_KEY) {
    twiml.say(intent.reply);
  } else {
    twiml.play(`${baseUrl}/tts?text=${encodeURIComponent(intent.reply)}`);
  }
  const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/handle-input`, method: 'POST', speechTimeout: 'auto' });
  return res.type('text/xml').send(twiml.toString());
});

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
    const gather = twiml.gather({ input: 'speech', action: `${baseUrl}/voice/schedule-time`, method: 'POST', speechTimeout: 'auto' });
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

// Initialize knowledge base then start server
if (!process.env.VERCEL) {
  initKnowledgeBase().finally(() => {
    const server = app.listen(port, () => {
      console.log(`Server listening on http://localhost:${port}`);
      console.log('POST /voice/answer will respond with TwiML to greet callers.');
      if (supabase) {
        console.log('[supabase] client initialized');
      } else {
        console.warn('[supabase] not initialized - set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
      }
    });

    server.on('error', (err) => {
      console.error('Server error:', err && err.message ? err.message : err);
      process.exit(1);
    });
  });
}

module.exports = app;

// --- Debug: list recent calls and fetch a call with messages/events ---
app.get('/debug/calls', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase not configured' });
    const { data, error } = await supabase
      .from('calls')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    return res.json({ ok: true, calls: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.get('/debug/calls/:sid', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'supabase not configured' });
    const callId = req.params.sid;
    const [{ data: call, error: e1 }, { data: messages, error: e2 }, { data: events, error: e3 }] = await Promise.all([
      supabase.from('calls').select('*').eq('id', callId).maybeSingle(),
      supabase.from('call_messages').select('*').eq('call_id', callId).order('created_at', { ascending: true }),
      supabase.from('call_events').select('*').eq('call_id', callId).order('created_at', { ascending: true }),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    if (e3) throw e3;
    return res.json({ ok: true, call, messages, events });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.get('/debug/calls/by-phone', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
    const calls = await getRecentCallsByPhone(phone, 10);
    return res.json({ ok: true, calls });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

app.get('/debug/calls/:sid/transcript', async (req, res) => {
  try {
    const sid = req.params.sid;
    const messages = await getCallTranscript(sid);
    return res.json({ ok: true, messages });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// Twilio status callback (configure on number): marks end and saves summary
app.post('/voice/status', express.urlencoded({ extended: false }), async (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus; // e.g., completed, busy, failed
  try {
    if (status === 'completed' && callSid) {
      const messages = await getCallTranscript(callSid);
      const summary = await generateCallSummaryFromMessages(messages, { businessName });
      if (summary) await saveCallSummary(callSid, summary);
    }
  } catch (e) {
    console.error('[status] summary error', e && e.message ? e.message : e);
  } finally {
    res.status(204).end();
  }
});


