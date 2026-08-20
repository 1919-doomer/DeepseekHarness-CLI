import type { NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from './sanitize.js'

export interface TextSink {
  write(text: string): unknown
}

export interface PlainRendererOptions {
  output?: TextSink
  debugUnknownEvents?: boolean
}

export class PlainRenderer {
  private readonly output: TextSink
  private readonly debugUnknownEvents: boolean
  private assistantLineOpen = false
  private streamedAssistantText = ''

  constructor(options: PlainRendererOptions = {}) {
    this.output = options.output ?? process.stdout
    this.debugUnknownEvents = options.debugUnknownEvents ?? false
  }

  render(event: NormalizedEvent): void {
    switch (event.kind) {
      case 'assistant-delta':
        if (!this.assistantLineOpen) {
          this.output.write('assistant> ')
          this.assistantLineOpen = true
        }
        this.streamedAssistantText += event.text
        this.output.write(sanitizeTerminalText(event.text))
        return

      case 'assistant-message':
        this.renderCommittedAssistant(event.text)
        return

      case 'tool-call':
        this.closeAssistantLine()
        this.output.write(
          `tool> ${sanitizeTerminalText(event.name)} (${sanitizeTerminalText(event.callId)}) ${sanitizeTerminalText(event.arguments)}\n`,
        )
        return

      case 'tool-result':
        this.closeAssistantLine()
        this.output.write(
          `tool${event.isError ? '!' : '<'} ${sanitizeTerminalText(event.callId)} ${sanitizeTerminalText(event.text)}\n`,
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
        this.output.write(`error> ${sanitizeTerminalText(event.message)}\n`)
        return

      case 'session-status':
        if (event.status === 'idle') this.closeAssistantLine()
        return

      case 'unknown':
        if (this.debugUnknownEvents) {
          this.closeAssistantLine()
          const type = event.type === undefined ? '' : `/${sanitizeTerminalText(event.type)}`
          this.output.write(`debug> unknown ${sanitizeTerminalText(event.method)}${type}\n`)
        }
        return

      case 'user-message':
      case 'internal':
        return
    }
  }

  finish(): void {
    this.closeAssistantLine()
    this.streamedAssistantText = ''
  }

  private renderCommittedAssistant(text: string): void {
    if (this.streamedAssistantText.length === 0) {
      this.closeAssistantLine()
      this.output.write(`assistant> ${sanitizeTerminalText(text)}\n`)
      return
    }

    if (text === this.streamedAssistantText) {
      this.closeAssistantLine()
    } else if (text.startsWith(this.streamedAssistantText)) {
      const suffix = sanitizeTerminalText(text.slice(this.streamedAssistantText.length))
      if (this.assistantLineOpen) {
        this.output.write(`${suffix}\n`)
        this.assistantLineOpen = false
      } else if (suffix.length > 0) {
        this.output.write(`assistant> ${suffix}\n`)
      }
    } else {
      this.closeAssistantLine()
      this.output.write(`assistant(committed)> ${sanitizeTerminalText(text)}\n`)
    }

    this.streamedAssistantText = ''
  }

  private closeAssistantLine(): void {
    if (!this.assistantLineOpen) return
    this.output.write('\n')
    this.assistantLineOpen = false
  }
}
