const { supabase } = require('./supabase');

async function upsertCall({ callSid, from, to, startedAt }) {
  if (!supabase) return;
  await supabase.from('calls').upsert({
    id: callSid,
    from_number: from,
    to_number: to,
    caller_phone: from,
    started_at: startedAt || new Date().toISOString(),
  });
}

async function markCallEnded({ callSid, endedAt, outcome, recordingUrl }) {
  if (!supabase) return;
  await supabase.from('calls').update({
    ended_at: endedAt || new Date().toISOString(),
    outcome: outcome || null,
    recording_url: recordingUrl || null,
  }).eq('id', callSid);
}

async function insertCallerMessage({ callSid, text, intent, datetimeISO }) {
  if (!supabase) return;
  await supabase.from('call_messages').insert({
    call_id: callSid,
    role: 'caller',
    text: text || '',
    intent: intent || null,
    datetime_iso: datetimeISO || null,
  });
}

async function insertAssistantMessage({ callSid, text, intent, datetimeISO }) {
  if (!supabase) return;
  await supabase.from('call_messages').insert({
    call_id: callSid,
    role: 'assistant',
    text: text || '',
    intent: intent || null,
    datetime_iso: datetimeISO || null,
  });
}

async function insertCallEvent({ callSid, type, payload }) {
  if (!supabase) return;
  await supabase.from('call_events').insert({
    call_id: callSid,
    type,
    payload: payload || {},
  });
}

async function upsertCaller({ phone, name, email, notes }) {
  if (!supabase || !phone) return;
  await supabase.from('callers').upsert({
    phone,
    name: name || null,
    email: email || null,
    notes: notes || null,
  });
}

async function getRecentCallsByPhone(phone, limit = 5) {
  if (!supabase || !phone) return [];
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('caller_phone', phone)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getCallTranscript(callId) {
  if (!supabase || !callId) return [];
  const { data, error } = await supabase
    .from('call_messages')
    .select('*')
    .eq('call_id', callId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function saveCallSummary(callId, summary) {
  if (!supabase || !callId || !summary) return;
  await supabase.from('call_summaries').insert({ call_id: callId, summary });
}

async function getLastSummaryByPhone(phone) {
  if (!supabase || !phone) return null;
  const { data: calls, error: e1 } = await supabase
    .from('calls')
    .select('id')
    .eq('caller_phone', phone)
    .order('started_at', { ascending: false })
    .limit(5);
  if (e1) throw e1;
  const callIds = (calls || []).map(c => c.id);
  if (callIds.length === 0) return null;
  const { data: summaries, error: e2 } = await supabase
    .from('call_summaries')
    .select('*')
    .in('call_id', callIds)
    .order('created_at', { ascending: false })
    .limit(1);
  if (e2) throw e2;
  return summaries && summaries[0] ? summaries[0].summary : null;
}

async function buildRecentMemorySnippet({ phone, callId }) {
  let parts = [];
  if (phone) {
    // caller profile
    const { data: caller } = await supabase.from('callers').select('*').eq('phone', phone).maybeSingle();
    if (caller) {
      parts.push(`Caller profile: name=${caller.name || 'unknown'}, email=${caller.email || 'unknown'}, phone=${phone}`);
    }
    const lastSummary = await getLastSummaryByPhone(phone);
    if (lastSummary) parts.push(`Last call summary: ${lastSummary}`);
  }
  if (callId) {
    const transcript = await getCallTranscript(callId);
    const recent = (transcript || []).slice(-6); // last few turns
    if (recent.length > 0) {
      const lines = recent.map(m => `${m.role}: ${m.text}`).join('\n');
      parts.push('Recent conversation:\n' + lines);
    }
  }
  return parts.join('\n');
}

module.exports = {
  upsertCall,
  markCallEnded,
  insertCallerMessage,
  insertAssistantMessage,
  insertCallEvent,
  upsertCaller,
  getRecentCallsByPhone,
  getCallTranscript,
  saveCallSummary,
  buildRecentMemorySnippet,
};
