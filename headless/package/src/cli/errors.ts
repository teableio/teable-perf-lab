import { HelpDoc, ValidationError } from '@effect/cli';

import { BenchError } from '../errors';

export type ErrorEnvelope = {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly details?: unknown;
    readonly message: string;
  };
};

const cliError = (error: ValidationError.ValidationError): BenchError => {
  const commandUnknown = error._tag === 'CommandMismatch' || error._tag === 'MissingSubcommand';
  const ansiEscape = String.fromCharCode(27);
  const rendered = HelpDoc.toAnsiText(error.error)
    .replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, 'g'), '')
    .trim();
  const expectedOption = /^Expected to find option: '--([^']+)'$/.exec(rendered)?.[1];
  const message = expectedOption === undefined ? rendered : `--${expectedOption} is required`;
  return new BenchError(
    commandUnknown ? 'bench.cli.command_unknown' : 'bench.cli.argument_invalid',
    message
  );
};

export const toErrorEnvelope = (cause: unknown): ErrorEnvelope => {
  const error = ValidationError.isValidationError(cause) ? cliError(cause) : cause;
  if (error instanceof BenchError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message.slice(error.code.length + 2),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'bench.cli.unexpected',
      message: error instanceof Error ? error.message : String(error),
    },
  };
};
