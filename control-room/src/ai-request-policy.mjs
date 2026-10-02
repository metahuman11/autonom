// Provider parameters are a capability boundary, not arbitrary model input.
// Function execution still requires an independent, fresh workbench grant.
const fail = (status, message) => Object.assign(new Error(message), {status});
const fields = new Set(['model','messages','stream','max_tokens','n','best_of','max_completion_tokens','tools','tool_choice','parallel_tool_calls']);
const names = new Set(['list_files','read_file','write_file','publish_site']);
export function validateAiRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'AI request must be an object');
  for (const key of Object.keys(body)) if (!fields.has(key)) throw fail(400, 'unsupported AI request field');
  if (body.stream != null && body.stream !== false) throw fail(400, 'streaming is not supported');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 160) throw fail(400, 'bounded AI messages required');
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || !['system','user','assistant','tool'].includes(m.role)) throw fail(400, 'invalid AI message');
    if (Object.keys(m).some(k => !['role','content','tool_calls','tool_call_id'].includes(k))) throw fail(400, 'unsupported AI message field');
    if (typeof m.content !== 'string' && !(m.role === 'assistant' && m.content === null && Array.isArray(m.tool_calls))) throw fail(400, 'AI message content must be text');
    if (m.tool_calls != null) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length > 5) throw fail(400, 'invalid AI tool history');
      for (const call of m.tool_calls) if (call?.type !== 'function' || !names.has(call.function?.name) || typeof call.function.arguments !== 'string' || typeof call.id !== 'string') throw fail(403, 'unsupported AI tool history');
    }
    if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || !m.tool_call_id.length)) throw fail(400, 'AI tool response requires its call id');
  }
  if (body.tools != null) {
    if (!Array.isArray(body.tools) || body.tools.length > names.size) throw fail(400, 'invalid AI tool list');
    const seen = new Set();
    for (const tool of body.tools) {
      if (tool?.type !== 'function' || Object.keys(tool).some(k => !['type','function'].includes(k)) || !names.has(tool.function?.name) || seen.has(tool.function.name)) throw fail(403, 'provider-hosted or unknown tools are not permitted');
      if (!tool.function.parameters || tool.function.parameters.type !== 'object') throw fail(400, 'invalid AI function schema');
      seen.add(tool.function.name);
    }
  }
  if (body.tool_choice != null && !['auto','none'].includes(body.tool_choice)) throw fail(403, 'forced AI tool calls are not permitted');
  if (body.parallel_tool_calls != null && body.parallel_tool_calls !== false) throw fail(403, 'parallel AI tool calls are not permitted');
}
export function requireAiToolScope(body, permissions) {
  const requested = new Set((body.tools || []).map(t => t.function.name));
  for (const m of body.messages) for (const call of m.tool_calls || []) requested.add(call.function.name);
  if (!requested.size && !body.messages.some(m => m.role === 'tool')) return;
  if (!permissions) throw fail(403, 'ordinary chat and mission requests cannot use tools');
  for (const name of requested) {
    const permission = ({list_files:'read',read_file:'read',write_file:'write',publish_site:'publish'})[name];
    if (permissions[permission] !== true) throw fail(403, 'AI tool exceeds the current task permission');
  }
}
