/**
 * Hume Conversation Retrieval and Parsing
 * 
 * Fetches conversation data from Hume after a call ends,
 * parses appointment details, and prepares for booking.
 */

const { DateTime } = require('luxon');
const { HumeClient } = require('hume');

const HUME_API_KEY = process.env.HUME_API_KEY;

/**
 * Fetch all chat events from Hume using the SDK iterator
 * This gets all messages, tool calls, and other events from the conversation
 */
async function fetchHumeConversation(chatId) {
  if (!HUME_API_KEY) {
    throw new Error('HUME_API_KEY not configured');
  }

  console.log(`[hume-api] fetching chat events: ${chatId}`);
  
  const client = new HumeClient({ apiKey: HUME_API_KEY });
  const allChatEvents = [];

  try {
    // Retrieve an async iterator over all chat events
    const chatEventsIterator = await client.empathicVoice.chats.listChatEvents(chatId, {
      pageNumber: 0, // Start from the first page
    });

    // Collect all events from the iterator
    for await (const chatEvent of chatEventsIterator) {
      allChatEvents.push(chatEvent);
    }

    console.log(`[hume-api] fetched ${allChatEvents.length} chat events`);
    
    // Convert to our expected format with event_messages
    const messages = allChatEvents
      .filter(event => event.type === 'USER_MESSAGE' || event.type === 'AGENT_MESSAGE')
      .map(event => ({
        role: event.type === 'USER_MESSAGE' ? 'user' : 'assistant',
        message: {
          content: event.message_text || event.text || ''
        },
        timestamp: event.timestamp
      }));

    return {
      id: chatId,
      event_messages: messages,
      all_events: allChatEvents, // Keep all events for debugging
    };
  } catch (err) {
    console.error(`[hume-api] error fetching chat:`, err?.message || err);
    throw err;
  }
}

/**
 * List recent Hume chats and find the one matching the call time/duration
 * This is a fallback when we don't have the chat_id stored
 */
async function findRecentHumeChat(callTimestamp, phoneNumber) {
  if (!HUME_API_KEY) {
    throw new Error('HUME_API_KEY not configured');
  }

  console.log(`[hume-api] listing recent chats to find match for ${phoneNumber}`);
  
  const client = new HumeClient({ apiKey: HUME_API_KEY });
  const recentChats = [];

  try {
    // List recent chats using the SDK
    const chatsIterator = await client.empathicVoice.chats.listChats({
      pageSize: 20, // Get last 20 chats to find a match
    });

    // Collect chats from iterator (limit to first page for speed)
    let count = 0;
    for await (const chat of chatsIterator) {
      recentChats.push(chat);
      count++;
      if (count >= 20) break; // Stop after first page
    }

    console.log(`[hume-api] found ${recentChats.length} recent chats`);
    
    // Find the most recent chat that matches the call time (within 2 minutes)
    const callTime = new Date(callTimestamp).getTime();
    for (const chat of recentChats) {
      const chatStartTime = new Date(chat.startTimestamp || chat.start_timestamp).getTime();
      const timeDiff = Math.abs(callTime - chatStartTime);
      
      // If chat started within 2 minutes of the call, it's likely a match
      if (timeDiff < 120000) { // 2 minutes tolerance
        console.log(`[hume-api] found matching chat: ${chat.id} (time diff: ${Math.round(timeDiff/1000)}s)`);
        return chat.id;
      }
    }
    
    // If no exact match, return the most recent chat
    if (recentChats.length > 0) {
      console.log(`[hume-api] no exact match, using most recent chat: ${recentChats[0].id}`);
      return recentChats[0].id;
    }
    
    throw new Error('No recent Hume chats found');
  } catch (err) {
    console.error(`[hume-api] error listing chats:`, err?.message || err);
    throw err;
  }
}

/**
 * Parse appointment details from conversation text
 * Looks for date, time, and customer info
 */
function parseAppointmentFromConversation(conversation) {
  const timezone = process.env.BUSINESS_TIMEZONE || 'America/Chicago';
  const now = DateTime.now().setZone(timezone);
  
  // Combine all messages into full text
  // Hume format: event_messages array with { role, message: { content } }
  // or legacy format: messages array with { content }
  let messages = conversation.event_messages || conversation.messages || [];
  const fullText = messages
    .map(m => {
      // Hume format
      if (m.message && m.message.content) return m.message.content;
      // Legacy format
      if (m.content) return m.content;
      if (m.text) return m.text;
      return '';
    })
    .join(' ')
    .toLowerCase();

  console.log('[parse-appointment] analyzing conversation text...');

  // Extract customer phone number (from Twilio, should be in metadata)
  const customerPhone = conversation.metadata?.from || conversation.from || '';
  
  // Extract customer name (look for "my name is X" or "I'm X")
  const nameMatch = fullText.match(/(?:my name is|i'm|i am|this is)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  const customerName = nameMatch ? nameMatch[1].trim() : '';

  // Date parsing - look for relative dates and specific dates
  let appointmentDate = null;
  
  // Check for "tomorrow"
  if (fullText.includes('tomorrow')) {
    appointmentDate = now.plus({ days: 1 });
  }
  // Check for "today"
  else if (fullText.includes('today')) {
    appointmentDate = now;
  }
  // Check for day of week (e.g., "monday", "next tuesday")
  else {
    const dayMatch = fullText.match(/(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (dayMatch) {
      const targetDay = dayMatch[1].toLowerCase();
      const daysOfWeek = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const targetDayIndex = daysOfWeek.indexOf(targetDay) + 1; // luxon uses 1=Monday
      
      let candidate = now.set({ weekday: targetDayIndex });
      if (candidate <= now || fullText.includes('next')) {
        candidate = candidate.plus({ weeks: 1 });
      }
      appointmentDate = candidate;
    }
  }
  
  // Check for specific date formats (MM/DD, November 15, etc.)
  const dateMatch = fullText.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (dateMatch && !appointmentDate) {
    const month = parseInt(dateMatch[1]);
    const day = parseInt(dateMatch[2]);
    appointmentDate = DateTime.fromObject({ 
      year: now.year, 
      month, 
      day 
    }, { zone: timezone });
    
    // If date is in the past, assume next year
    if (appointmentDate < now) {
      appointmentDate = appointmentDate.plus({ years: 1 });
    }
  }

  // Time parsing - look for times like "2pm", "14:00", "2:30"
  let startTime = null;
  let endTime = null;
  
  const timeMatch = fullText.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const meridian = timeMatch[3]?.toLowerCase();
    
    // Convert to 24-hour format
    if (meridian === 'pm' && hour < 12) hour += 12;
    if (meridian === 'am' && hour === 12) hour = 0;
    
    startTime = { hour, minute };
    // Default 30-minute appointment
    const endHour = minute + 30 >= 60 ? hour + 1 : hour;
    const endMinute = (minute + 30) % 60;
    endTime = { hour: endHour, minute: endMinute };
  }

  // Service/tier mentioned
  const serviceMentions = fullText.match(/(haircut|fade|lineup|shave|trim|first.time|returning|preferred)/gi);
  const service = serviceMentions ? serviceMentions.join(', ') : 'General appointment';

  return {
    found: !!(appointmentDate && startTime),
    date: appointmentDate ? appointmentDate.toFormat('yyyy-MM-dd') : null,
    startTime: startTime ? `${String(startTime.hour).padStart(2, '0')}:${String(startTime.minute).padStart(2, '0')}` : null,
    endTime: endTime ? `${String(endTime.hour).padStart(2, '0')}:${String(endTime.minute).padStart(2, '0')}` : null,
    timezone,
    customerName,
    customerPhone,
    service,
    summary: customerName ? `${customerName} - ${service}` : service,
    description: `Booked via phone conversation. ${customerName ? `Customer: ${customerName}` : ''} ${customerPhone ? `Phone: ${customerPhone}` : ''}`.trim(),
  };
}

module.exports = {
  fetchHumeConversation,
  findRecentHumeChat,
  parseAppointmentFromConversation,
};

