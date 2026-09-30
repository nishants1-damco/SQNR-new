// The pipeline logs through whatever the host gives it (pino in the worker),
// with pino's argument order: fields first, then the message.
export interface PipelineLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const silentLogger: PipelineLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const errString = (err: unknown) => (err instanceof Error ? err.message : String(err));
