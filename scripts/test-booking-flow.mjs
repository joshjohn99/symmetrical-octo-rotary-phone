#!/usr/bin/env node
// Test the complete booking flow
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { HumeClient } from 'hume';

async function testFlow() {
  console.log('🧪 Testing Booking Flow\n');

  // 1. Check environment variables
  console.log('1️⃣ Checking environment variables...');
  const requiredVars = [
    'HUME_API_KEY',
    'HUME_CONFIG_ID',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
  ];

  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    process.exit(1);
  }
  console.log('✅ All environment variables present\n');

  // 2. Test Hume API connection
  console.log('2️⃣ Testing Hume API connection...');
  try {
    const client = new HumeClient({ apiKey: process.env.HUME_API_KEY });
    const chatsIterator = await client.empathicVoice.chats.listChats({ pageSize: 1 });
    let count = 0;
    for await (const chat of chatsIterator) {
      count++;
      if (count >= 1) break;
    }
    console.log(`✅ Hume API connected (found ${count} recent chats)\n`);
  } catch (err) {
    console.error('❌ Hume API error:', err.message);
    process.exit(1);
  }

  // 3. Test booking endpoint
  console.log('3️⃣ Testing booking endpoint...');
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];

    // Use native fetch (Node 18+) or dynamic import
    const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
    
    const response = await fetchFn('http://localhost:3001/tools/hume/book-appointment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendarId: 'primary',
        date: dateStr,
        startTime: '16:00',
        endTime: '16:30',
        timezone: 'America/Chicago',
        summary: 'Flow Test Appointment',
        description: 'Automated test of booking flow'
      }),
    });

    const result = await response.json();
    if (result.ok) {
      console.log('✅ Booking endpoint works!');
      console.log('   Event ID:', result.event.id);
      console.log('   Link:', result.event.htmlLink);
      console.log('   Time:', result.event.start.dateTime, '\n');
    } else {
      console.error('❌ Booking failed:', result.error);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Booking endpoint error:', err.message);
    process.exit(1);
  }

  // 4. Check Twilio webhook configuration
  console.log('4️⃣ Checking Twilio webhook setup...');
  console.log('⚠️  MANUAL CHECK REQUIRED:');
  console.log('   1. Go to: https://console.twilio.com/');
  console.log('   2. Find your phone number');
  console.log('   3. Check "Status Callback URL"');
  console.log('   4. Should be: https://your-domain.com/voice/call-status');
  console.log('   5. If using localhost, you need ngrok or a deployed URL\n');

  // 5. Summary
  console.log('📋 Summary:');
  console.log('✅ Server is running');
  console.log('✅ Environment variables configured');
  console.log('✅ Hume API accessible');
  console.log('✅ Google Calendar booking works');
  console.log('\n🎯 Next Steps:');
  console.log('1. Make sure Twilio Status Callback URL is configured');
  console.log('2. Make a test call to your Twilio number');
  console.log('3. Watch server logs for [call-status] and [post-call-booking] messages');
  console.log('4. Check your Google Calendar after the call ends\n');
}

testFlow().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

