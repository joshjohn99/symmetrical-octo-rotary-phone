// Update Hume EVI Config to include the book_appointment tool
// Usage: node ai-receptionist/scripts/hume-update-config.mjs

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { HumeClient } from 'hume';

async function main() {
  const apiKey = process.env.HUME_API_KEY;
  const configId = process.env.HUME_CONFIG_ID;
  
  if (!apiKey) throw new Error('HUME_API_KEY missing');
  if (!configId) throw new Error('HUME_CONFIG_ID missing');

  const client = new HumeClient({ apiKey });

  // First, list your existing tools to get the book_appointment tool ID
  console.log('[hume] Listing tools...');
  const toolsResp = await client.empathicVoice.tools.listTools();
  
  // Handle both array response and paginated response
  const toolsList = Array.isArray(toolsResp) ? toolsResp : (toolsResp.data || toolsResp.tools || []);
  const bookAppointmentTool = toolsList.find(t => t.name === 'book_appointment');
  
  if (!bookAppointmentTool) {
    console.warn('⚠️  book_appointment tool not found. Config will be updated without tools.');
    console.log('Available tools:', toolsList.map(t => t.name).join(', ') || 'none');
  } else {
    console.log('[hume] Found book_appointment tool:', bookAppointmentTool.id);
  }

  // List prompts to get the receptionist prompt ID
  console.log('[hume] Listing prompts...');
  const promptsResp = await client.empathicVoice.prompts.listPrompts();
  
  // Handle both array response and paginated response
  const promptsList = Array.isArray(promptsResp) ? promptsResp : (promptsResp.data || promptsResp.prompts || []);
  const receptionistPrompt = promptsList.find(p => p.name === 'PFL Receptionist');
  
  if (!receptionistPrompt) {
    console.error('❌ PFL Receptionist prompt not found.');
    console.log('Available prompts:', promptsList.map(p => p.name).join(', ') || 'none');
    console.log('Please create or update the prompt first using hume-update-prompt.mjs');
    process.exit(1);
  }

  console.log('[hume] Found PFL Receptionist prompt:', receptionistPrompt.id);

  // Update the config to include the prompt (and tool if available)
  console.log('[hume] Updating config...');
  
  // Get current config first
  const currentConfig = await client.empathicVoice.configs.getConfig(configId);
  console.log('[hume] Current config retrieved');
  
  const updatePayload = {
    name: currentConfig.name || 'PFL Receptionist Config',
    prompt: { id: receptionistPrompt.id },
    voice: currentConfig.voice,
    languageModel: currentConfig.language_model,
  };
  
  // Only add tools if we found the book_appointment tool
  if (bookAppointmentTool) {
    updatePayload.tools = [{ id: bookAppointmentTool.id }];
  }
  
  // Try creating a new config version
  try {
    const updateResp = await client.empathicVoice.configs.createConfigVersion(configId, updatePayload);
    console.log('[hume] ✅ Config updated successfully!');
    console.log('Config ID:', configId);
    console.log('Version:', updateResp.version);
    console.log('Prompt:', receptionistPrompt.name);
    console.log('Tools:', bookAppointmentTool ? bookAppointmentTool.name : 'none');
  } catch (err) {
    console.error('[hume] Error creating config version:', err?.message || err);
    console.log('[hume] Note: Config may need to be updated manually in Hume Portal');
    console.log('[hume] Go to: https://platform.hume.ai');
    console.log('[hume] - Select your config');
    console.log('[hume] - Set Prompt to: PFL Receptionist');
    if (bookAppointmentTool) {
      console.log('[hume] - Add Tool: book_appointment');
    }
    throw err;
  }
}

main().catch((e) => {
  console.error('[hume] update config error:', e?.message || e);
  if (e?.body) {
    console.error('Response body:', JSON.stringify(e.body, null, 2));
  }
  process.exit(1);
});

