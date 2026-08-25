import type { NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from './sanitize.js'

export interface TextSink {
  write(text: string): unknown
}

export interface PlainRendererOptions {
  output?: TextSink
  debugUnknownEvents?: boolean
  rootSessionId?: string
}

export class PlainRenderer {
  private readonly output: TextSink
  private readonly debugUnknownEvents: boolean
  private rootSessionId: string | undefined
  private assistantLineSessionId: string | undefined
  private readonly streamedAssistantText = new Map<string, string>()

  constructor(options: PlainRendererOptions = {}) {
    this.output = options.output ?? process.stdout
    this.debugUnknownEvents = options.debugUnknownEvents ?? false
    this.rootSessionId = options.rootSessionId
  }

  setRootSessionId(sessionId: string): void {
    if (this.assistantLineSessionId !== undefined && this.assistantLineSessionId !== sessionId) {
      this.closeAssistantLine()
    }
    this.rootSessionId = sessionId
  }

  render(event: NormalizedEvent): void {
    this.observeRootSession(event)

    switch (event.kind) {
      case 'assistant-delta':
        this.renderAssistantDelta(event.sessionId, event.text)
        return

      case 'assistant-message':
        this.renderCommittedAssistant(event.sessionId, event.text)
        return

      case 'tool-call':
        this.closeAssistantLine()
        this.output.write(
          `${this.scopedLabel('tool', event.sessionId)}> ${sanitizeTerminalText(event.name)} (${sanitizeTerminalText(event.callId)}) ${sanitizeTerminalText(event.arguments)}\n`,
        )
        return

      case 'tool-result':
        this.closeAssistantLine()
        this.output.write(
          `${this.scopedLabel(event.isError ? 'tool!' : 'tool<', event.sessionId)} ${sanitizeTerminalText(event.callId)} ${sanitizeTerminalText(event.text)}\n`,
        )
        return

      case 'subagent-started':
        this.closeAssistantLine()
        this.output.write(
          `agent+ ${sanitizeTerminalText(event.childSessionId)} <- ${sanitizeTerminalText(event.parentSessionId)}${event.provider === undefined ? '' : ` [${sanitizeTerminalText(event.provider)}]`}\n`,
        )
        return

      case 'subagent-finished':
        this.closeAssistantLine()
        this.output.write(`agent- ${sanitizeTerminalText(event.childSessionId)}\n`)
        return

      case 'turn-error':
        this.closeAssistantLine()
        this.output.write(`${this.scopedLabel('error', event.sessionId)}> ${sanitizeTerminalText(event.message)}\n`)
        return

      case 'session-status':
        if (event.status === 'idle' && this.assistantLineSessionId === event.sessionId) {
          this.closeAssistantLine()
        }
        return

      case 'unknown':
        if (this.debugUnknownEvents) {
          this.closeAssistantLine()
          const type = event.type === undefined ? '' : `/${sanitizeTerminalText(event.type)}`
          const scope = event.sessionId === undefined ? '' : ` [${this.sessionTag(event.sessionId)}]`
          this.output.write(`debug> unknown ${sanitizeTerminalText(event.method)}${type}${scope}\n`)
        }
        return

      case 'user-message':
      case 'request-context':
      case 'approval-asked':
      case 'approval-decided':
      case 'approval-policy':
      case 'internal':
        return
    }
  }

  finish(): void {
    this.closeAssistantLine()
    this.streamedAssistantText.clear()
  }

  private renderAssistantDelta(sessionId: string, text: string): void {
    if (this.assistantLineSessionId !== sessionId) {
      this.closeAssistantLine()
      this.output.write(`${this.scopedLabel('assistant', sessionId)}> `)
      this.assistantLineSessionId = sessionId
    }
    this.streamedAssistantText.set(
      sessionId,
      (this.streamedAssistantText.get(sessionId) ?? '') + text,
    )
    this.output.write(sanitizeTerminalText(text))
  }

  private renderCommittedAssistant(sessionId: string, text: string): void {
    const streamed = this.streamedAssistantText.get(sessionId) ?? ''

    if (streamed.length === 0) {
      this.closeAssistantLine()
      this.output.write(`${this.scopedLabel('assistant', sessionId)}> ${sanitizeTerminalText(text)}\n`)
      return
    }

    if (text === streamed) {
      if (this.assistantLineSessionId === sessionId) this.closeAssistantLine()
    } else if (text.startsWith(streamed)) {
      const suffix = sanitizeTerminalText(text.slice(streamed.length))
      if (this.assistantLineSessionId === sessionId) {
        this.output.write(`${suffix}\n`)
        this.assistantLineSessionId = undefined
      } else if (suffix.length > 0) {
        this.closeAssistantLine()
        this.output.write(`${this.scopedLabel('assistant', sessionId)}> ${suffix}\n`)
      }
    } else {
      this.closeAssistantLine()
      this.output.write(`${this.scopedLabel('assistant(committed)', sessionId)}> ${sanitizeTerminalText(text)}\n`)
    }

    this.streamedAssistantText.delete(sessionId)
  }

  private closeAssistantLine(): void {
    if (this.assistantLineSessionId === undefined) return
    this.output.write('\n')
    this.assistantLineSessionId = undefined
  }

  private observeRootSession(event: NormalizedEvent): void {
    if (this.rootSessionId !== undefined) return
    if ('sessionId' in event && typeof event.sessionId === 'string') {
      this.rootSessionId = event.sessionId
      return
    }
    if (event.kind === 'subagent-started') this.rootSessionId = event.parentSessionId
  }

  private scopedLabel(base: string, sessionId: string): string {
    if (this.rootSessionId === undefined || sessionId === this.rootSessionId) return base
    return `${base}[${this.sessionTag(sessionId)}]`
  }

  private sessionTag(sessionId: string): string {
    const compact = sessionId.startsWith('session-') ? sessionId.slice(-8) : sessionId.slice(0, 12)
    return sanitizeTerminalText(compact)
  }
}
