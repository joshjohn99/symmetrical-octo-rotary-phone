const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });

const pdfParse = require('pdf-parse');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';

const knowledgeDir = path.resolve(process.cwd(), 'knowledge');
let memory = [];

function chunkText(text, maxLen = 800) {
  const parts = [];
  let current = '';
  const sentences = text.split(/(?<=[\.!?])\s+/);
  for (const s of sentences) {
    if ((current + ' ' + s).trim().length > maxLen) {
      if (current.trim()) parts.push(current.trim());
      current = s;
    } else {
      current += (current ? ' ' : '') + s;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

async function embedBatch(chunks) {
  if (chunks.length === 0) return [];
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: chunks });
  return res.data.map((d) => d.embedding);
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

async function readPdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const { text } = await pdfParse(buf);
  return text || '';
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

async function initKnowledgeBase() {
  try {
    if (!fs.existsSync(knowledgeDir)) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
      console.log('[knowledge] created folder:', knowledgeDir);
    }
    const files = fs.readdirSync(knowledgeDir)
      .filter((f) => /\.(pdf|txt|md)$/i.test(f))
      .map((f) => path.join(knowledgeDir, f));
    const allChunks = [];
    for (const file of files) {
      let text = '';
      const ext = path.extname(file).toLowerCase();
      try {
        if (ext === '.pdf') text = await readPdf(file);
        else text = readText(file);
      } catch (e) {
        console.error('[knowledge] read error', file, e && e.message ? e.message : e);
        continue;
      }
      const cleaned = text.replace(/\s+/g, ' ').trim();
      const chunks = chunkText(cleaned, 1200);
      for (const c of chunks) {
        allChunks.push({ file, text: c });
      }
    }
    const embeddings = await embedBatch(allChunks.map((c) => c.text));
    memory = allChunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));
    console.log(`[knowledge] loaded ${memory.length} chunks from ${knowledgeDir}`);
  } catch (e) {
    console.error('[knowledge] init error', e && e.message ? e.message : e);
    memory = [];
  }
}

async function getRelevantContext(query, topK = 4) {
  if (!query || memory.length === 0) return '';
  const { data } = await openai.embeddings.create({ model: EMBED_MODEL, input: query });
  const q = data[0].embedding;
  const scored = memory.map((m) => ({ m, score: cosineSim(q, m.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK).map((s) => s.m.text);
  return top.join('\n---\n');
}

module.exports = { initKnowledgeBase, getRelevantContext };


