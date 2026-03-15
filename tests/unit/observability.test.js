/**
 * Tests unitarios para Observability (Logger, Tracer, Metrics)
 *
 * Ejecutar con: node tests/unit/observability.test.js
 */

const assert = require('assert');
const { Logger, Tracer, Metrics } = require('../../core/observability');

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
  console.log('\n🧪 Running Observability Tests\n');

  // ===== Logger Tests =====
  console.log('📝 Logger Tests\n');

  test('Logger creates log entry with correct structure', () => {
    const logger = new Logger({ level: 'info', coreId: 'test-core' });
    const entry = logger.createLogEntry('info', 'test.message', { key: 'value' });

    assert.strictEqual(entry.level, 'info');
    assert.strictEqual(entry.core_id, 'test-core');
    assert.strictEqual(entry.message, 'test.message');
    assert.deepStrictEqual(entry.context, { key: 'value' });
    assert.ok(entry.timestamp);
  });

  test('Logger respects log level', () => {
    let outputCalled = false;
    const logger = new Logger({
      level: 'warn',
      coreId: 'test',
      output: () => { outputCalled = true; }
    });

    logger.debug('should.not.log');
    assert.strictEqual(outputCalled, false);

    logger.info('should.not.log');
    assert.strictEqual(outputCalled, false);

    logger.warn('should.log');
    assert.strictEqual(outputCalled, true);
  });

  test('Logger includes error details', () => {
    const logger = new Logger({ level: 'error', coreId: 'test' });
    const error = new Error('Test error');
    error.customProp = 'custom value';

    const entry = logger.createLogEntry('error', 'error.occurred', {}, error);

    assert.ok(entry.error);
    assert.strictEqual(entry.error.name, 'Error');
    assert.strictEqual(entry.error.message, 'Test error');
    assert.ok(entry.error.stack);
    assert.strictEqual(entry.error.customProp, 'custom value');
  });

  test('Logger child includes parent context', () => {
    const outputs = [];
    const logger = new Logger({
      level: 'info',
      coreId: 'test',
      output: (msg) => outputs.push(msg)
    });

    const childLogger = logger.child({ module: 'test-module' });
    childLogger.info('test.message', { extra: 'data' });

    assert.strictEqual(outputs.length, 1);
    assert.ok(outputs[0].includes('test.message'));
    assert.ok(outputs[0].includes('test-module'));
  });

  // ===== Tracer Tests =====
  console.log('\n🔍 Tracer Tests\n');

  test('Tracer generates valid trace and span IDs', () => {
    const tracer = new Tracer({ coreId: 'test-core' });

    const traceId = tracer.generateTraceId();
    const spanId = tracer.generateSpanId();

    assert.strictEqual(traceId.length, 32); // 16 bytes = 32 hex chars
    assert.strictEqual(spanId.length, 16);  // 8 bytes = 16 hex chars
    assert.ok(/^[0-9a-f]+$/.test(traceId));
    assert.ok(/^[0-9a-f]+$/.test(spanId));
  });

  test('Tracer creates trace with correct structure', () => {
    const tracer = new Tracer({ coreId: 'test-core' });
    const trace = tracer.start('test.operation');

    assert.ok(trace.context.traceId);
    assert.ok(trace.context.spanId);
    assert.strictEqual(trace.context.operationName, 'test.operation');
    assert.ok(trace.context.startTime);
    assert.strictEqual(trace.context.parentSpanId, null);
  });

  test('Tracer creates child span with parent context', () => {
    const tracer = new Tracer({ coreId: 'test-core' });
    const parentTrace = tracer.start('parent.operation');
    const childTrace = tracer.start('child.operation', parentTrace.context);

    assert.strictEqual(childTrace.context.traceId, parentTrace.context.traceId);
    assert.notStrictEqual(childTrace.context.spanId, parentTrace.context.spanId);
    assert.strictEqual(childTrace.context.parentSpanId, parentTrace.context.spanId);
  });

  test('Tracer adds tags and logs', () => {
    const tracer = new Tracer({ coreId: 'test-core' });
    const trace = tracer.start('test.operation');

    trace.addTag('key1', 'value1');
    trace.addTag('key2', 123);
    trace.addLog('log message', { field: 'value' });

    assert.strictEqual(trace.context.tags.key1, 'value1');
    assert.strictEqual(trace.context.tags.key2, 123);
    assert.strictEqual(trace.context.logs.length, 1);
    assert.strictEqual(trace.context.logs[0].message, 'log message');
  });

  test('Tracer end() calculates duration', () => {
    const tracer = new Tracer({ coreId: 'test-core' });
    const trace = tracer.start('test.operation');

    const data = trace.end();

    assert.ok(data.duration_ms >= 0);
    assert.strictEqual(data.trace_id, trace.context.traceId);
    assert.strictEqual(data.span_id, trace.context.spanId);
    assert.strictEqual(data.operation_name, 'test.operation');
  });

  test('Tracer inject/extract works correctly', () => {
    const tracer = new Tracer({ coreId: 'test-core' });
    const trace = tracer.start('test.operation');

    const event = { data: 'test' };
    const injected = tracer.inject(event, trace.context);

    assert.ok(injected.trace);
    assert.strictEqual(injected.trace.trace_id, trace.context.traceId);

    const extracted = tracer.extract(injected);
    assert.strictEqual(extracted.traceId, trace.context.traceId);
  });

  test('Tracer W3C format conversion', () => {
    const tracer = new Tracer({ coreId: 'test-core' });
    const trace = tracer.start('test.operation');

    const w3c = tracer.toW3C(trace.context);
    assert.ok(w3c.startsWith('00-'));
    assert.ok(w3c.endsWith('-01'));

    const parts = w3c.split('-');
    assert.strictEqual(parts.length, 4);
    assert.strictEqual(parts[1], trace.context.traceId);
    assert.strictEqual(parts[2], trace.context.spanId);
  });

  // ===== Metrics Tests =====
  console.log('\n📊 Metrics Tests\n');

  test('Metrics increment counter', () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    metrics.increment('test.counter');
    assert.strictEqual(metrics.getCounter('test.counter'), 1);

    metrics.increment('test.counter', 5);
    assert.strictEqual(metrics.getCounter('test.counter'), 6);
  });

  test('Metrics decrement counter', () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    metrics.increment('test.counter', 10);
    metrics.decrement('test.counter', 3);

    assert.strictEqual(metrics.getCounter('test.counter'), 7);
  });

  test('Metrics observe histogram values', () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    metrics.observe('test.histogram', 10);
    metrics.observe('test.histogram', 20);
    metrics.observe('test.histogram', 30);

    const hist = metrics.getHistogram('test.histogram');

    assert.strictEqual(hist.count, 3);
    assert.strictEqual(hist.sum, 60);
    assert.strictEqual(hist.min, 10);
    assert.strictEqual(hist.max, 30);
    assert.strictEqual(hist.avg, 20);
  });

  test('Metrics calculates percentiles', () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    // Add 100 values: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      metrics.observe('test.histogram', i);
    }

    const hist = metrics.getHistogram('test.histogram');

    assert.strictEqual(hist.count, 100);
    assert.strictEqual(hist.min, 1);
    assert.strictEqual(hist.max, 100);
    assert.ok(hist.p50 >= 40 && hist.p50 <= 60);
    assert.ok(hist.p95 >= 90 && hist.p95 <= 100);
    assert.ok(hist.p99 >= 95 && hist.p99 <= 100);
  });

  await testAsync('Metrics measure async function', async () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    const result = await metrics.measure('test.operation', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'success';
    });

    assert.strictEqual(result, 'success');

    const hist = metrics.getHistogram('test.operation');
    assert.strictEqual(hist.count, 1);
    assert.ok(hist.avg >= 10); // At least 10ms
  });

  test('Metrics measureSync for sync functions', () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    const result = metrics.measureSync('test.sync', () => {
      return 'success';
    });

    assert.strictEqual(result, 'success');
    assert.strictEqual(metrics.getHistogram('test.sync').count, 1);
  });

  test('Metrics getStats returns all metrics', () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    metrics.increment('counter1', 5);
    metrics.increment('counter2', 10);
    metrics.observe('histogram1', 100);
    metrics.observe('histogram1', 200);

    const stats = metrics.getStats();

    assert.strictEqual(stats.core_id, 'test-core');
    assert.strictEqual(stats.counters.counter1, 5);
    assert.strictEqual(stats.counters.counter2, 10);
    assert.strictEqual(stats.histograms.histogram1.count, 2);
    assert.ok(stats.timestamp);
  });

  test('Metrics resetAll clears all metrics', () => {
    const metrics = new Metrics({ coreId: 'test-core' });

    metrics.increment('counter', 5);
    metrics.observe('histogram', 100);

    metrics.resetAll();

    assert.strictEqual(metrics.getCounter('counter'), 0);
    assert.strictEqual(metrics.getHistogram('histogram').count, 0);
  });

  console.log('\n✅ All Observability tests passed!\n');
}

runTests().catch(error => {
  console.error('\n❌ Test suite failed:', error);
  process.exit(1);
});
