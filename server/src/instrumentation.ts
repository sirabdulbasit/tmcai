import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';

// Telemetry is OPT-IN. Two modes:
//   - OTEL_EXPORTER_OTLP_ENDPOINT set → ship spans to that collector
//   - OTEL_DEBUG_CONSOLE=1 set        → print spans to stdout (local dev only)
//   - neither                         → no SDK, no telemetry, no log noise
//
// The previous default fell through to ConsoleSpanExporter when no
// endpoint was configured. On production that produced ~5 giant JSON
// span objects per HTTP request, drowning real log lines and making
// pm2 logs unreadable. Bare minimum: telemetry ships somewhere useful
// or doesn't run at all.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const debugConsole = process.env.OTEL_DEBUG_CONSOLE === '1';

if (endpoint || debugConsole) {
  const exporter = endpoint
    ? new OTLPTraceExporter({ url: endpoint })
    : new ConsoleSpanExporter();

  const sdk = new NodeSDK({
    serviceName: 'tmcai-server',
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-http': { enabled: true },
      '@opentelemetry/instrumentation-pg': { enabled: true },
    })],
  });

  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown());
  console.log(`[otel] enabled, exporter=${endpoint ? 'otlp' : 'console'}`);
} else {
  console.log('[otel] disabled (set OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_DEBUG_CONSOLE=1 to enable)');
}
