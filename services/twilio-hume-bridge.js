/**
 * Twilio ↔ Hume EVI Bridge with Tool Support
 * 
 * This bridge connects Twilio Media Streams with Hume EVI WebSocket,
 * enabling tool use during phone calls.
 * 
 * Flow:
 * 1. Twilio sends audio via WebSocket (Media Streams)
 * 2. We forward audio to Hume EVI WebSocket
 * 3. Hume sends back audio + tool_call messages
 * 4. We intercept tool_calls, execute them, send tool_response back to Hume
 * 5. We forward Hume's audio back to Twilio
 */

const WebSocket = require('ws');
const { handleToolCallMessage } = require('./hume-tool-handler');

const HUME_API_KEY = process.env.HUME_API_KEY;
const HUME_CONFIG_ID = process.env.HUME_CONFIG_ID;
const TOOL_BRIDGE_BASE = process.env.TOOL_BRIDGE_BASE || 'http://localhost:3001';

/**
 * Start Twilio-Hume bridge for a WebSocket connection
 * @param {WebSocket} twilioWs - Twilio Media Streams WebSocket
 * @param {string} callSid - Twilio Call SID
 */
async function startTwilioHumeBridge(twilioWs, callSid) {
  console.log(`[twilio-hume-bridge][${callSid}] starting bridge`);

  try {
    // Connect to Hume EVI WebSocket directly
    const humeWsUrl = `wss://api.hume.ai/v0/evi/chat?api_key=${encodeURIComponent(HUME_API_KEY)}&config_id=${encodeURIComponent(HUME_CONFIG_ID)}`;
    const humeSocket = new WebSocket(humeWsUrl);

    let humeReady = false;

    humeSocket.on('open', () => {
      console.log(`[twilio-hume-bridge][${callSid}] connected to Hume EVI`);
      humeReady = true;
    });

    // Twilio → Hume: forward media
    twilioWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.event === 'media' && humeReady) {
          // Forward audio payload to Hume
          // Twilio sends base64 mulaw audio in msg.media.payload
          // Hume expects: { type: "audio_input", data: "base64..." }
          humeSocket.send(JSON.stringify({
            type: 'audio_input',
            data: msg.media.payload,
          }));
        } else if (msg.event === 'start') {
          console.log(`[twilio-hume-bridge][${callSid}] Twilio stream started`);
        } else if (msg.event === 'stop') {
          console.log(`[twilio-hume-bridge][${callSid}] Twilio stream stopped`);
          humeSocket.close();
        }
      } catch (err) {
        console.error(`[twilio-hume-bridge][${callSid}] error processing Twilio message:`, err?.message || err);
      }
    });

    // Hume → Twilio: forward audio + handle tool calls
    humeSocket.on('message', async (rawData) => {
      try {
        const message = JSON.parse(rawData.toString());
        console.log(`[twilio-hume-bridge][${callSid}] Hume message type:`, message?.type);
        
        // Log full message for error types
        if (message?.type === 'error') {
          console.error(`[twilio-hume-bridge][${callSid}] Hume error message:`, JSON.stringify(message, null, 2));
        }

        if (message?.type === 'tool_call') {
          // Handle tool call
          console.log(`[twilio-hume-bridge][${callSid}] 🔧 tool_call:`, message.name);
          // Create a wrapper with send methods for the tool handler
          const socketWrapper = {
            sendToolResponseMessage: (msg) => {
              humeSocket.send(JSON.stringify(msg));
            },
            sendToolErrorMessage: (msg) => {
              humeSocket.send(JSON.stringify(msg));
            }
          };
          await handleToolCallMessage(message, socketWrapper, TOOL_BRIDGE_BASE);
        } else if (message?.type === 'audio_output') {
          // Forward audio back to Twilio
          // Hume sends base64 audio in message.data
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: callSid,
            media: {
              payload: message.data,
            },
          }));
        }
      } catch (err) {
        console.error(`[twilio-hume-bridge][${callSid}] error processing Hume message:`, err?.message || err);
      }
    });

    humeSocket.on('close', (code, reason) => {
      console.log(`[twilio-hume-bridge][${callSid}] Hume socket closed:`, code, reason.toString());
      twilioWs.close();
    });

    humeSocket.on('error', (err) => {
      console.error(`[twilio-hume-bridge][${callSid}] Hume socket error:`, err?.message || err);
    });

    twilioWs.on('close', () => {
      console.log(`[twilio-hume-bridge][${callSid}] Twilio socket closed`);
      if (humeSocket.readyState === WebSocket.OPEN) {
        humeSocket.close();
      }
    });

    twilioWs.on('error', (err) => {
      console.error(`[twilio-hume-bridge][${callSid}] Twilio socket error:`, err?.message || err);
    });

  } catch (err) {
    console.error(`[twilio-hume-bridge][${callSid}] failed to start:`, err?.message || err);
    twilioWs.close();
  }
}

module.exports = { startTwilioHumeBridge };

