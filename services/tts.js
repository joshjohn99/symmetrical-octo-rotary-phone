const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const DEFAULT_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'nova';
const REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_TTS_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 8000);

async function synthesizeSpeech(text, opts = {}) {
  const model = opts.model || DEFAULT_TTS_MODEL;
  const voice = opts.voice || DEFAULT_TTS_VOICE;
  if (!text || !text.trim()) throw new Error('text required');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const speech = await client.audio.speech.create({
    model,
    voice,
    input: text.trim(),
    format: 'mp3',
  }, { signal: ac.signal });
  clearTimeout(t);
  const buffer = Buffer.from(await speech.arrayBuffer());
  return { buffer, contentType: 'audio/mpeg' };
}

module.exports = { synthesizeSpeech };


