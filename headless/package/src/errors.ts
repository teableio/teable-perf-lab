export class BenchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(`${code}: ${message}`);
    this.name = 'BenchError';
  }
}
