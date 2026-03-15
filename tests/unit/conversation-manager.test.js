/**
 * Tests para Conversation Manager Module
 *
 * Pruebas unitarias para las funciones del conversation-manager:
 * - formatBytes: Formateo de bytes a string legible
 * - composeSystemPrompt: Composición de prompts con template variables
 * - formatToolsForLLM: Conversión de tools a formato OpenAI
 * - formatToolResultsAsMessages: Formateo de resultados de tool calls
 *
 * Run: node tests/unit/conversation-manager.test.js
 */

const ConversationManagerModule = require('../../modules/conversation-manager');

// Test framework simple
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(str, substring, message) {
  if (!str.includes(substring)) {
    throw new Error(`${message}\nExpected to include: "${substring}"\nActual: "${str}"`);
  }
}

async function test(description, fn) {
  try {
    await fn();
    console.log(`✓ ${description}`);
    testsPassed++;
  } catch (error) {
    console.error(`✗ ${description}`);
    console.error(`  ${error.message}`);
    testsFailed++;
  }
}

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log('🧪 Testing Conversation Manager Module\n');

  // Crear instancia del módulo para testing
  const manager = new ConversationManagerModule();
  manager.config = {
    defaultSystemPrompt: 'You are a helpful assistant.',
    includeProjectContext: true,
    includeStorageInfo: true,
    includeTools: true
  };

  // --------------------------------------------------------------------------
  // formatBytes Tests
  // --------------------------------------------------------------------------

  console.log('\n📦 formatBytes\n');

  await test('formatBytes: debe retornar "0 B" para null o undefined', async () => {
    assertEqual(manager.formatBytes(null), '0 B', 'null');
    assertEqual(manager.formatBytes(undefined), '0 B', 'undefined');
    assertEqual(manager.formatBytes(0), '0 B', 'zero');
  });

  await test('formatBytes: debe formatear bytes correctamente', async () => {
    assertEqual(manager.formatBytes(100), '100 B', '100 bytes');
    assertEqual(manager.formatBytes(1024), '1 KB', '1 KB');
    assertEqual(manager.formatBytes(1536), '1.5 KB', '1.5 KB');
  });

  await test('formatBytes: debe formatear megabytes correctamente', async () => {
    assertEqual(manager.formatBytes(1048576), '1 MB', '1 MB');
    assertEqual(manager.formatBytes(2621440), '2.5 MB', '2.5 MB');
  });

  await test('formatBytes: debe formatear gigabytes correctamente', async () => {
    assertEqual(manager.formatBytes(1073741824), '1 GB', '1 GB');
    assertEqual(manager.formatBytes(5368709120), '5 GB', '5 GB');
  });

  // --------------------------------------------------------------------------
  // formatToolsForLLM Tests
  // --------------------------------------------------------------------------

  console.log('\n🔧 formatToolsForLLM\n');

  await test('formatToolsForLLM: debe retornar null para array vacío', async () => {
    assertEqual(manager.formatToolsForLLM([]), null, 'array vacío');
    assertEqual(manager.formatToolsForLLM(null), null, 'null');
    assertEqual(manager.formatToolsForLLM(undefined), null, 'undefined');
  });

  await test('formatToolsForLLM: debe convertir tool básico', async () => {
    const tools = [{
      full_name: 'test_tool',
      description: 'A test tool',
      schema: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input']
      }
    }];

    const result = manager.formatToolsForLLM(tools);

    assert(result.length === 1, 'Debe tener 1 tool');
    assertEqual(result[0].type, 'function', 'type=function');
    assertEqual(result[0].function.name, 'test_tool', 'nombre correcto');
    assertEqual(result[0].function.description, 'A test tool', 'descripción correcta');
    assert(result[0].function.parameters.properties.input, 'schema incluido');
  });

  await test('formatToolsForLLM: debe usar schema por defecto si no hay', async () => {
    const tools = [{
      full_name: 'simple_tool',
      description: 'Simple tool'
    }];

    const result = manager.formatToolsForLLM(tools);

    assertEqual(result[0].function.parameters.type, 'object', 'type object');
    assertEqual(result[0].function.parameters.properties, {}, 'properties vacío');
    assertEqual(result[0].function.parameters.required, [], 'required vacío');
  });

  await test('formatToolsForLLM: debe usar full_name como descripción si no hay', async () => {
    const tools = [{
      full_name: 'no_desc_tool'
    }];

    const result = manager.formatToolsForLLM(tools);

    assertEqual(result[0].function.description, 'Tool: no_desc_tool', 'descripción por defecto');
  });

  await test('formatToolsForLLM: debe manejar múltiples tools', async () => {
    const tools = [
      { full_name: 'tool1', description: 'Tool 1' },
      { full_name: 'tool2', description: 'Tool 2' },
      { full_name: 'tool3', description: 'Tool 3' }
    ];

    const result = manager.formatToolsForLLM(tools);

    assert(result.length === 3, 'Debe tener 3 tools');
    assertEqual(result[0].function.name, 'tool1', 'primer tool');
    assertEqual(result[1].function.name, 'tool2', 'segundo tool');
    assertEqual(result[2].function.name, 'tool3', 'tercer tool');
  });

  // --------------------------------------------------------------------------
  // composeSystemPrompt Tests
  // --------------------------------------------------------------------------

  console.log('\n📝 composeSystemPrompt\n');

  await test('composeSystemPrompt: debe usar system_prompt de la conversación', async () => {
    const conversation = {
      system_prompt: 'Custom prompt for this conversation',
      title: 'Test'
    };

    const result = manager.composeSystemPrompt(conversation, null, null);

    assertIncludes(result, 'Custom prompt for this conversation', 'prompt incluido');
  });

  await test('composeSystemPrompt: debe usar defaultSystemPrompt si no hay en conversación', async () => {
    const conversation = { title: 'Test' };

    const result = manager.composeSystemPrompt(conversation, null, null);

    assertIncludes(result, 'You are a helpful assistant.', 'default prompt');
  });

  await test('composeSystemPrompt: debe sustituir template variables', async () => {
    const conversation = {
      system_prompt: 'Welcome to {{project_name}}! Today is {{date}}. You have {{tools_count}} tools.',
      title: 'Chat'
    };
    const projectContext = {
      project_name: 'My Project'
    };
    const tools = [{ name: 'tool1' }, { name: 'tool2' }];

    const result = manager.composeSystemPrompt(conversation, projectContext, tools);

    assertIncludes(result, 'Welcome to My Project!', 'project_name sustituido');
    assertIncludes(result, 'You have 2 tools.', 'tools_count sustituido');
    // date es dinámico, solo verificamos que no tenga el placeholder
    assert(!result.includes('{{date}}'), 'date sustituido');
  });

  await test('composeSystemPrompt: debe incluir contexto de proyecto', async () => {
    const conversation = { system_prompt: 'Base prompt', title: 'Test' };
    const projectContext = {
      project_name: 'Test Project',
      project_description: 'A test project for testing'
    };

    const result = manager.composeSystemPrompt(conversation, projectContext, null);

    assertIncludes(result, '## Project Context', 'sección de proyecto');
    assertIncludes(result, 'Test Project', 'nombre del proyecto');
    assertIncludes(result, 'A test project for testing', 'descripción');
  });

  await test('composeSystemPrompt: debe incluir info de storage si está habilitado', async () => {
    const conversation = { system_prompt: 'Base', title: 'Test' };
    const projectContext = {
      project_name: 'Test',
      storage_info: {
        file_count: 42,
        total_size: 1048576 // 1 MB
      }
    };

    const result = manager.composeSystemPrompt(conversation, projectContext, null);

    assertIncludes(result, '42 files', 'file count');
    assertIncludes(result, '1 MB', 'tamaño formateado');
  });

  await test('composeSystemPrompt: debe incluir sección de tools', async () => {
    const conversation = { system_prompt: 'Base', title: 'Test' };
    const tools = [
      { function: { name: 'search', description: 'Search the web' } },
      { function: { name: 'calculate', description: 'Do math' } }
    ];

    const result = manager.composeSystemPrompt(conversation, null, tools);

    assertIncludes(result, '## Available Tools', 'sección de tools');
    assertIncludes(result, '2 tool(s)', 'conteo de tools');
    assertIncludes(result, 'search', 'nombre de tool');
    assertIncludes(result, 'Search the web', 'descripción de tool');
    assertIncludes(result, 'calculate', 'segundo tool');
  });

  await test('composeSystemPrompt: debe manejar tools con formato directo (sin function wrapper)', async () => {
    const conversation = { system_prompt: 'Base', title: 'Test' };
    const tools = [
      { name: 'direct_tool', description: 'Direct format tool' }
    ];

    const result = manager.composeSystemPrompt(conversation, null, tools);

    assertIncludes(result, 'direct_tool', 'nombre directo');
    assertIncludes(result, 'Direct format tool', 'descripción directa');
  });

  await test('composeSystemPrompt: debe manejar variables con espacios', async () => {
    const conversation = {
      system_prompt: 'Project: {{ project_name }} - Tools: {{  tools_count  }}',
      title: 'Test'
    };
    const projectContext = { project_name: 'Spaced Project' };
    const tools = [{ name: 't1' }];

    const result = manager.composeSystemPrompt(conversation, projectContext, tools);

    assertIncludes(result, 'Project: Spaced Project', 'variable con espacios');
    assertIncludes(result, 'Tools: 1', 'variable con múltiples espacios');
  });

  // --------------------------------------------------------------------------
  // formatToolResultsAsMessages Tests
  // --------------------------------------------------------------------------

  console.log('\n💬 formatToolResultsAsMessages\n');

  await test('formatToolResultsAsMessages: debe crear mensaje assistant con tool_calls', async () => {
    const toolCalls = [
      { id: 'call_1', function: { name: 'search', arguments: '{"q":"test"}' } }
    ];
    const toolResults = [
      { tool_call_id: 'call_1', success: true, result: 'Found results' }
    ];

    const messages = manager.formatToolResultsAsMessages(toolCalls, toolResults);

    assert(messages.length === 2, 'Debe tener 2 mensajes');
    assertEqual(messages[0].role, 'assistant', 'primer mensaje es assistant');
    assertEqual(messages[0].content, null, 'content null en assistant');
    assert(messages[0].tool_calls.length === 1, 'tiene tool_calls');
  });

  await test('formatToolResultsAsMessages: debe crear mensajes tool con resultados', async () => {
    const toolCalls = [
      { id: 'call_1', function: { name: 'calc' } }
    ];
    const toolResults = [
      { tool_call_id: 'call_1', success: true, result: { answer: 42 } }
    ];

    const messages = manager.formatToolResultsAsMessages(toolCalls, toolResults);

    assertEqual(messages[1].role, 'tool', 'segundo mensaje es tool');
    assertEqual(messages[1].tool_call_id, 'call_1', 'tool_call_id correcto');
    assertIncludes(messages[1].content, '42', 'resultado serializado');
  });

  await test('formatToolResultsAsMessages: debe manejar errores en tool results', async () => {
    const toolCalls = [
      { id: 'call_err', function: { name: 'fail' } }
    ];
    const toolResults = [
      { tool_call_id: 'call_err', success: false, error: 'Connection timeout' }
    ];

    const messages = manager.formatToolResultsAsMessages(toolCalls, toolResults);

    assertIncludes(messages[1].content, 'Error:', 'prefijo de error');
    assertIncludes(messages[1].content, 'Connection timeout', 'mensaje de error');
  });

  await test('formatToolResultsAsMessages: debe manejar múltiples tool calls', async () => {
    const toolCalls = [
      { id: 'call_a', function: { name: 'tool_a' } },
      { id: 'call_b', function: { name: 'tool_b' } },
      { id: 'call_c', function: { name: 'tool_c' } }
    ];
    const toolResults = [
      { tool_call_id: 'call_a', success: true, result: 'A result' },
      { tool_call_id: 'call_b', success: false, error: 'B failed' },
      { tool_call_id: 'call_c', success: true, result: 'C result' }
    ];

    const messages = manager.formatToolResultsAsMessages(toolCalls, toolResults);

    assert(messages.length === 4, '1 assistant + 3 tool messages');
    assertEqual(messages[1].tool_call_id, 'call_a', 'primer tool');
    assertEqual(messages[2].tool_call_id, 'call_b', 'segundo tool');
    assertEqual(messages[3].tool_call_id, 'call_c', 'tercer tool');
    assertIncludes(messages[1].content, 'A result', 'resultado A');
    assertIncludes(messages[2].content, 'Error:', 'error B');
    assertIncludes(messages[3].content, 'C result', 'resultado C');
  });

  await test('formatToolResultsAsMessages: debe serializar string directamente', async () => {
    const toolCalls = [{ id: 'str_call', function: { name: 'echo' } }];
    const toolResults = [
      { tool_call_id: 'str_call', success: true, result: 'Plain string result' }
    ];

    const messages = manager.formatToolResultsAsMessages(toolCalls, toolResults);

    assertEqual(messages[1].content, 'Plain string result', 'string sin JSON.stringify');
  });

  // --------------------------------------------------------------------------
  // Inicialización Tests
  // --------------------------------------------------------------------------

  console.log('\n🚀 Inicialización\n');

  await test('ConversationManagerModule: debe inicializarse con valores por defecto', async () => {
    const mod = new ConversationManagerModule();

    assertEqual(mod.name, 'conversation-manager', 'nombre correcto');
    assertEqual(mod.version, '1.0.0', 'versión correcta');
    assert(mod.conversations instanceof Map, 'conversations es Map');
    assert(mod.messages instanceof Map, 'messages es Map');
    assert(mod.pendingDbRequests instanceof Map, 'pendingDbRequests es Map');
    assert(mod.pendingAIRequests instanceof Map, 'pendingAIRequests es Map');
    assert(mod.pendingToolRequests instanceof Map, 'pendingToolRequests es Map');
    assert(mod.pendingToolCallRequests instanceof Map, 'pendingToolCallRequests es Map');
  });

  await test('ConversationManagerModule: debe tener configuración de tools', async () => {
    const mod = new ConversationManagerModule();

    assertEqual(mod.toolsCacheTTL, 60000, 'TTL de cache 1 minuto');
    assertEqual(mod.maxToolCallIterations, 10, 'max iteraciones 10');
    assertEqual(mod.toolsCache, null, 'cache inicialmente null');
  });

  // --------------------------------------------------------------------------
  // Resumen
  // --------------------------------------------------------------------------

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Tests passed: ${testsPassed}`);
  console.log(`❌ Tests failed: ${testsFailed}`);
  console.log(`📊 Total: ${testsPassed + testsFailed}`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
});
