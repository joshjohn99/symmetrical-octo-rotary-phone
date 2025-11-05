/**
 * Hume tool_call handler (bridge)
 *
 * Usage: wire this into your Hume chat socket listener. When you receive a
 * ToolCall message, pass it to handleToolCallMessage along with the socket.
 * The handler will POST to your local bridge endpoint and reply with
 * tool_response or tool_error via the provided socket.
 */

const DEFAULT_BASE_URL = process.env.TOOL_BRIDGE_BASE || 'http://localhost:3001';

/**
 * @param {object} toolCallMessage - Hume ToolCall message
 * @param {object} socket - Hume chat socket instance exposing sendToolResponseMessage / sendToolErrorMessage
 * @param {string} [baseUrl] - base URL for your voice server (default http://localhost:3001)
 */
async function handleToolCallMessage(toolCallMessage, socket, baseUrl = DEFAULT_BASE_URL) {
  console.log('[hume-tool-handler] received tool_call:', JSON.stringify(toolCallMessage, null, 2));
  
  try {
    const name = toolCallMessage?.name || toolCallMessage?.tool_name || '';
    const toolCallId = toolCallMessage?.toolCallId || toolCallMessage?.tool_call_id;
    const paramsStr = toolCallMessage?.parameters || toolCallMessage?.args || '{}';

    console.log('[hume-tool-handler] tool name:', name, 'toolCallId:', toolCallId);

    if (name !== 'book_appointment') {
      console.error('[hume-tool-handler] unsupported tool:', name);
      return socket.sendToolErrorMessage?.({
        type: 'tool_error',
        toolCallId,
        error: 'Tool not found',
        content: 'The requested tool is not supported by this server',
      });
    }

    let params;
    try {
      params = JSON.parse(paramsStr);
      console.log('[hume-tool-handler] parsed params:', JSON.stringify(params, null, 2));
    } catch (e) {
      console.error('[hume-tool-handler] malformed params:', paramsStr);
      return socket.sendToolErrorMessage?.({
        type: 'tool_error',
        toolCallId,
        error: 'Malformed parameters',
        content: 'Parameters were not valid JSON',
      });
    }

    // POST to our calendar bridge
    console.log('[hume-tool-handler] POSTing to:', `${baseUrl}/tools/hume/book-appointment`);
    const resp = await fetch(`${baseUrl}/tools/hume/book-appointment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    console.log('[hume-tool-handler] bridge response status:', resp.status);

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[hume-tool-handler] ❌ bridge error:', resp.status, text);
      return socket.sendToolErrorMessage?.({
        type: 'tool_error',
        toolCallId,
        error: `Bridge error ${resp.status}`,
        content: text?.slice(0, 500) || 'Error creating event',
        fallback_content: 'I could not book that time. Would you like to try another time?',
      });
    }

    const data = await resp.json();
    console.log('[hume-tool-handler] bridge response:', JSON.stringify(data, null, 2));
    const content = JSON.stringify(data?.event || data);
    console.log('[hume-tool-handler] ✅ sending tool_response to Hume with content:', content);
    return socket.sendToolResponseMessage?.({
      type: 'tool_response',
      toolCallId,
      content,
    });
  } catch (err) {
    console.error('[hume-tool-handler] ❌ unhandled error:', err?.message || err);
    return socket.sendToolErrorMessage?.({
      type: 'tool_error',
      toolCallId: toolCallMessage?.toolCallId || toolCallMessage?.tool_call_id,
      error: 'Unhandled tool error',
      content: err && err.message ? err.message : String(err),
      fallback_content: 'Something went wrong while booking. Want to try a different time?',
    });
  }
}

module.exports = { handleToolCallMessage };


