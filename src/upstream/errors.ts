import {
  JsonRpcResponseError,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from '@deepseek-ai/dsh-sdk-client'

export type RuntimeErrorCode =
  | 'compatibility'
  | 'configuration'
  | 'protocol'
  | 'request-timeout'
  | 'activity-timeout'
  | 'transport-closed'
  | 'runtime'

export class DshcRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: RuntimeErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DshcRuntimeError'
  }
}

export class CompatibilityError extends DshcRuntimeError {
  constructor(message: string) {
    super(message, 'compatibility')
    this.name = 'CompatibilityError'
  }
}

export class ActivityTimeoutError extends DshcRuntimeError {
  constructor(timeoutMs: number) {
    super(
      `Harness activity did not reach idle within ${timeoutMs}ms. The current DSH protocol has no prompt-level cancel; the owning runtime must be closed to abandon this activity.`,
      'activity-timeout',
    )
    this.name = 'ActivityTimeoutError'
  }
}

export function classifyRuntimeError(error: unknown, env: NodeJS.ProcessEnv = process.env): DshcRuntimeError {
  if (error instanceof DshcRuntimeError) return error

  let code: RuntimeErrorCode = 'runtime'
  if (error instanceof JsonRpcResponseError || error instanceof SdkProtocolError) code = 'protocol'
  else if (error instanceof RequestTimeoutError) code = 'request-timeout'
  else if (error instanceof TransportClosedError) code = 'transport-closed'

  const rawMessage = error instanceof Error ? error.message : String(error)
  return new DshcRuntimeError(redactSensitiveText(rawMessage, env), code, {
    cause: error instanceof Error ? error : undefined,
  })
}

const SENSITIVE_NAME = /(?:api[_-]?key|token|secret|password|authorization|credential)/i

export function redactSensitiveText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = text

  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_NAME.test(name) || typeof value !== 'string' || value.length < 4) continue
    result = result.split(value).join('[REDACTED]')
  }

  result = result
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9._-]{8,}\b/g, '[REDACTED]')

  return result
}
