/**
 * Tests unitarios para HookManager
 *
 * Ejecutar con: node tests/unit/hooks.test.js
 */

const assert = require('assert');
const HookManager = require('../../core/hooks');

// Helper para tests
function test(description, fn) {
  try {
    fn();
    console.log(`✓ ${description}`);
  } catch (error) {
    console.error(`✗ ${description}`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

async function testAsync(description, fn) {
  try {
    await fn();
    console.log(`✓ ${description}`);
  } catch (error) {
    console.error(`✗ ${description}`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('\n🧪 Running HookManager Tests\n');

// Test 1: Constructor
test('Constructor creates empty hooks object', () => {
  const hooks = new HookManager();
  assert.deepStrictEqual(hooks.hooks, {});
  assert.deepStrictEqual(hooks.stats, {});
});

// Test 2: Register hook
test('Register adds handler to hook', () => {
  const hooks = new HookManager();
  const handler = async (ctx) => ctx;

  hooks.register('test', handler);

  assert.strictEqual(hooks.hooks['test'].length, 1);
  assert.strictEqual(hooks.hooks['test'][0], handler);
});

// Test 3: Register múltiples handlers
test('Register allows multiple handlers for same hook', () => {
  const hooks = new HookManager();
  const handler1 = async (ctx) => ctx;
  const handler2 = async (ctx) => ctx;

  hooks.register('test', handler1);
  hooks.register('test', handler2);

  assert.strictEqual(hooks.hooks['test'].length, 2);
});

// Test 4: Unregister hook
test('Unregister removes handler', () => {
  const hooks = new HookManager();
  const handler = async (ctx) => ctx;

  const unregister = hooks.register('test', handler);
  assert.strictEqual(hooks.hooks['test'].length, 1);

  unregister();
  assert.strictEqual(hooks.hooks['test'].length, 0);
});

  // Test 5: Execute sin handlers
  await testAsync('Execute without handlers returns context unchanged', async () => {
  const hooks = new HookManager();
  const context = { foo: 'bar' };

  const result = await hooks.execute('nonexistent', context);

  assert.deepStrictEqual(result, context);
});

// Test 6: Execute con un handler
await testAsync('Execute with one handler passes context', async () => {
  const hooks = new HookManager();
  const context = { value: 1 };

  hooks.register('test', async (ctx) => {
    return { ...ctx, value: ctx.value + 1 };
  });

  const result = await hooks.execute('test', context);

  assert.deepStrictEqual(result, { value: 2 });
});

// Test 7: Execute con múltiples handlers (chain)
await testAsync('Execute chains multiple handlers', async () => {
  const hooks = new HookManager();
  const context = { value: 1 };

  hooks.register('test', async (ctx) => ({ ...ctx, value: ctx.value + 1 }));
  hooks.register('test', async (ctx) => ({ ...ctx, value: ctx.value * 2 }));
  hooks.register('test', async (ctx) => ({ ...ctx, value: ctx.value + 10 }));

  const result = await hooks.execute('test', context);

  // (1 + 1) * 2 + 10 = 14
  assert.deepStrictEqual(result, { value: 14 });
});

// Test 8: Handler retorna null (bloqueo)
await testAsync('Handler returning null blocks operation', async () => {
  const hooks = new HookManager();
  const context = { value: 1 };

  hooks.register('test', async (ctx) => null);

  const result = await hooks.execute('test', context);

  assert.strictEqual(result, null);
});

// Test 9: Handler retorna undefined (mantiene contexto)
await testAsync('Handler returning undefined keeps context', async () => {
  const hooks = new HookManager();
  const context = { value: 1 };

  hooks.register('test', async (ctx) => {
    // Side effect pero no modifica context
    return undefined;
  });

  const result = await hooks.execute('test', context);

  assert.deepStrictEqual(result, { value: 1 });
});

// Test 10: Bloqueo en medio de chain
await testAsync('Blocking in middle of chain stops execution', async () => {
  const hooks = new HookManager();
  const context = { value: 1 };

  let thirdHandlerCalled = false;

  hooks.register('test', async (ctx) => ({ ...ctx, value: ctx.value + 1 }));
  hooks.register('test', async (ctx) => null); // Bloquear aquí
  hooks.register('test', async (ctx) => {
    thirdHandlerCalled = true;
    return ctx;
  });

  const result = await hooks.execute('test', context);

  assert.strictEqual(result, null);
  assert.strictEqual(thirdHandlerCalled, false); // No debe ejecutarse
});

// Test 11: Error handling
await testAsync('Execute throws error from handler with enhanced info', async () => {
  const hooks = new HookManager();

  hooks.register('test', async (ctx) => {
    throw new Error('Handler error');
  });

  try {
    await hooks.execute('test', {});
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error.message.includes('Hook handler error'));
    assert.ok(error.message.includes('test'));
    assert.strictEqual(error.hookName, 'test');
    assert.strictEqual(error.handlerIndex, 0);
  }
});

// Test 12: Clear hook
test('Clear removes all handlers from hook', () => {
  const hooks = new HookManager();

  hooks.register('test', async (ctx) => ctx);
  hooks.register('test', async (ctx) => ctx);

  assert.strictEqual(hooks.hooks['test'].length, 2);

  hooks.clear('test');

  assert.strictEqual(hooks.hooks['test'].length, 0);
});

// Test 13: Clear all
test('ClearAll removes all hooks', () => {
  const hooks = new HookManager();

  hooks.register('test1', async (ctx) => ctx);
  hooks.register('test2', async (ctx) => ctx);

  hooks.clearAll();

  assert.deepStrictEqual(hooks.hooks, {});
});

// Test 14: Get handler count
test('GetHandlerCount returns correct count', () => {
  const hooks = new HookManager();

  assert.strictEqual(hooks.getHandlerCount('test'), 0);

  hooks.register('test', async (ctx) => ctx);
  assert.strictEqual(hooks.getHandlerCount('test'), 1);

  hooks.register('test', async (ctx) => ctx);
  assert.strictEqual(hooks.getHandlerCount('test'), 2);
});

// Test 15: List hooks
test('ListHooks returns all registered hook names', () => {
  const hooks = new HookManager();

  hooks.register('hook1', async (ctx) => ctx);
  hooks.register('hook2', async (ctx) => ctx);
  hooks.register('hook3', async (ctx) => ctx);

  const names = hooks.listHooks();

  assert.ok(names.includes('hook1'));
  assert.ok(names.includes('hook2'));
  assert.ok(names.includes('hook3'));
  assert.strictEqual(names.length, 3);
});

// Test 16: Stats - executions
await testAsync('Stats track executions', async () => {
  const hooks = new HookManager();

  hooks.register('test', async (ctx) => ctx);

  await hooks.execute('test', {});
  await hooks.execute('test', {});
  await hooks.execute('test', {});

  const stats = hooks.getStats('test');
  assert.strictEqual(stats.executions, 3);
});

// Test 17: Stats - blocked
await testAsync('Stats track blocked operations', async () => {
  const hooks = new HookManager();

  hooks.register('test', async (ctx) => null);

  await hooks.execute('test', {});
  await hooks.execute('test', {});

  const stats = hooks.getStats('test');
  assert.strictEqual(stats.blocked, 2);
});

// Test 18: Stats - errors
await testAsync('Stats track errors', async () => {
  const hooks = new HookManager();

  hooks.register('test', async (ctx) => {
    throw new Error('Test error');
  });

  try {
    await hooks.execute('test', {});
  } catch {}

  try {
    await hooks.execute('test', {});
  } catch {}

  const stats = hooks.getStats('test');
  assert.strictEqual(stats.errors, 2);
});

// Test 19: Reset stats
await testAsync('ResetStats clears statistics', async () => {
  const hooks = new HookManager();

  hooks.register('test', async (ctx) => ctx);

  await hooks.execute('test', {});
  await hooks.execute('test', {});

  assert.strictEqual(hooks.getStats('test').executions, 2);

  hooks.resetStats('test');

  assert.strictEqual(hooks.getStats('test').executions, 0);
});

// Test 20: Validation - invalid hookName
test('Register throws on invalid hookName', () => {
  const hooks = new HookManager();

  assert.throws(() => {
    hooks.register('', async (ctx) => ctx);
  }, /hookName must be a non-empty string/);

  assert.throws(() => {
    hooks.register(null, async (ctx) => ctx);
  }, /hookName must be a non-empty string/);
});

// Test 21: Validation - invalid handler
test('Register throws on invalid handler', () => {
  const hooks = new HookManager();

  assert.throws(() => {
    hooks.register('test', 'not a function');
  }, /handler must be a function/);

  assert.throws(() => {
    hooks.register('test', null);
  }, /handler must be a function/);
});

  console.log('\n✅ All tests passed!\n');
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
});
