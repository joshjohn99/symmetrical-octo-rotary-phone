const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { z } = require('zod');

const { getCurrentDateTimeISO } = require('./datetime');

let OpenAI;
try {
  OpenAI = require('openai');
} catch (err) {
  throw new Error('openai package not installed');
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || !apiKey.trim()) {
  throw new Error('Missing OPENAI_API_KEY in .env.local');
}

const client = new OpenAI({ apiKey });
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const greetingTemperature = Number(process.env.GREETING_TEMPERATURE || 0.8);
const { receptionistPrompt, receptionistExamples } = require('../prompts/receptionist');
const { calendarPrompt } = require('../prompts/calendar');
const { servicesPrompt } = require('../prompts/services');
const { arenamindFAQ } = require('../prompts/FAQ');

const IntentSchema = z.object({
  intent: z.enum(['schedule', 'hours', 'greeting', 'transfer', 'general']).default('general'),
  reply: z.string().min(1).max(800),
  datetimeISO: z.string().optional(),
});

// Using json_object response format for broader model compatibility

async function inferIntentFromText(text, opts) {
  const businessName = (opts && opts.businessName) || 'ArenaMinds AI';
  let now = getCurrentDateTimeISO();
  const timezone = (opts && opts.timezone) || 'America/Chicago';
  const context = (opts && opts.context) || '';
  const system = [
    servicesPrompt.system(),
    receptionistPrompt.system(businessName),
    calendarPrompt.system(),
    arenamindFAQ.system(),
    '',
    // Operational instructions for the task format the app expects
    'Analyze caller utterances and decide the intent.',
    'Intent MUST be one of: schedule | hours | greeting | transfer | general.',
    'Return a short, friendly reply to speak back to the caller.',
    'If the caller wants to book, provide datetime in ISO 8601 (timezone-aware if possible).',
    `Assume timezone ${timezone} when interpreting dates if none given.`,
    'Dates MUST be in the future relative to “now”; use the current year (or next) to avoid past dates.',
    'If the user says things like “tomorrow at 3pm,” resolve relative to today and ensure it is future-dated.',
    'When booking, attempt to capture caller name, phone number, and email; include these details in the suggested summary or description.',
    context ? '\nBusiness knowledge (use only if relevant):\n' + context : ''
  ].join('\n');

  const user = [
    'Caller said:',
    text,
    'Respond ONLY as a JSON object with fields: intent, reply, datetimeISO (optional).',
  ].join('\n');

  if (process.env.DEBUG_AI) {
    console.log('[openai] using model:', model);
  }
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const content = resp.choices?.[0]?.message?.content || '{}';
  if (process.env.DEBUG_AI) {
    console.log('[openai] raw content:', content);
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    // Try to salvage a JSON object from the content
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (__) {
        parsed = { intent: 'general', reply: 'Thanks for calling. How can I help you?', datetimeISO:  now};
      }
    } else {
      parsed = { intent: 'general', reply: 'Thanks for calling. How can I help you?', datetimeISO:  now};
    }
  }
  // Normalize common synonyms from models
  try {
    const mapping = {
      book_appointment: 'schedule',
      booking: 'schedule',
      schedule_appointment: 'schedule',
      appointment: 'schedule',
      book: 'schedule',
      greet: 'greeting',
      hello: 'greeting',
      transfer_call: 'transfer',
      route: 'transfer',
      hours_info: 'hours',
      open_hours: 'hours',
      inquire_about_business: 'general',
      business_info: 'general',
      about_business: 'general',
    };
    if (parsed && parsed.intent) {
      const key = String(parsed.intent).toLowerCase().replace(/\s+/g, '_');
      if (mapping[key]) parsed.intent = mapping[key];
      else if (['schedule', 'hours', 'greeting', 'transfer', 'general'].includes(key)) parsed.intent = key;
      else parsed.intent = 'general';
    } else {
      parsed.intent = 'general';
    }
  } catch (_) {
    // ignore
  }
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'datetimeISO') && parsed.datetimeISO == null) {
    delete parsed.datetimeISO;
  }
  const result = IntentSchema.safeParse(parsed);
  if (!result.success) {
    if (process.env.DEBUG_AI) {
      console.log('[openai] validation issues:', result.error.issues);
    }
    // Preserve model reply if present, defaulting intent to general
    const safeReply = parsed && typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : 'Thanks for calling. How can I help you?';
    return { intent: 'general', reply: safeReply, datetimeISO: now };
  }
  return result.data;
}

module.exports = { inferIntentFromText };

// Generate a single-sentence, varied greeting using higher temperature
async function generateGreeting(opts) {
  const businessName = "ArenaMinds AI";
  const agentName = "Olivia";
  const templates = receptionistExamples && typeof receptionistExamples.greetingTemplates === 'function'
    ? receptionistExamples.greetingTemplates(businessName, agentName)
    : [];
  if (templates.length > 0) {
    const pick = templates[Math.floor(Math.random() * templates.length)];
    if (pick && pick.trim()) return pick.trim();
  }
  // Fallback to LLM if templates missing
  const system = [
    receptionistPrompt.system(businessName),
    'Generate ONLY a single, short first-line greeting. Do not ask follow-ups.',
  ].join('\n');
  const user = `One friendly greeting sentence for ${businessName}.`;
  const resp = await client.chat.completions.create({
    model,
    temperature: greetingTemperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const content = resp.choices?.[0]?.message?.content?.trim();
  return content || `Hello, you've reached ${businessName}.`;
}

module.exports.generateGreeting = generateGreeting;

// Summarize a call transcript into 1-3 concise sentences
async function generateCallSummaryFromMessages(messages, opts) {
  const businessName = (opts && opts.businessName) || 'our office';
  const system = [
    receptionistPrompt.system(businessName),
    'You are summarizing a phone call. Be concise (1-3 sentences). Include outcome/next steps if any.',
  ].join('\n');
  const lines = (messages || []).map(m => `${m.role}: ${m.text}`).join('\n');
  const user = `Summarize this call:\n${lines}`;
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return resp.choices?.[0]?.message?.content?.trim() || '';
}

module.exports.generateCallSummaryFromMessages = generateCallSummaryFromMessages;


