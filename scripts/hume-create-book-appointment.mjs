// Registers the Hume tool: book_appointment (Google Calendar booking)
// Usage: HUME_API_KEY=... node ai-receptionist/scripts/hume-create-book-appointment.mjs
import path from 'path';
import dotenv from 'dotenv';
import { HumeClient } from 'hume';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const apiKey = process.env.HUME_API_KEY;
  if (!apiKey) {
    throw new Error('HUME_API_KEY missing in environment');
  }

  const client = new HumeClient({ apiKey });

  const parameters = JSON.stringify({
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: "Google Calendar ID. Use 'primary' if unspecified.",
        default: 'primary'
      },
      date: {
        type: 'string',
        description: 'Local date YYYY-MM-DD (e.g., 2025-11-05)'
      },
      startTime: {
        type: 'string',
        description: 'Start time HH:mm (24h) (e.g., 14:30)'
      },
      endTime: {
        type: 'string',
        description: 'End time HH:mm (24h) (e.g., 15:00)'
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone (e.g., America/Chicago). Optional; defaults server/business timezone.'
      }
    },
    required: ['date', 'startTime', 'endTime'],
    additionalProperties: false
  });

  const resp = await client.empathicVoice.tools.createTool({
    name: 'book_appointment',
    parameters,
    versionDescription: 'Creates a Google Calendar event using date + start/end time window.',
    description: 'Books an event on Google Calendar (primary by default).',
    fallbackContent: 'Unable to book appointment.'
  });

  console.log('[hume] tool created:', resp?.id || resp);
}

main().catch((e) => {
  console.error('[hume] tool create error:', e?.message || e);
  process.exit(1);
});


