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
  private assistantStreaming = false
  private streamedAssistantText = ''

  constructor(options: PlainRendererOptions = {}) {
    this.output = options.output ?? process.stdout
    this.debugUnknownEvents = options.debugUnknownEvents ?? false
  }

  render(event: NormalizedEvent): void {
    switch (event.kind) {
      case 'assistant-delta':
        if (!this.assistantStreaming) {
          this.output.write('assistant> ')
          this.assistantStreaming = true
          this.streamedAssistantText = ''
        }
        this.streamedAssistantText += event.text
        this.output.write(sanitizeTerminalText(event.text))
        return

      case 'assistant-message':
        this.renderCommittedAssistant(event.text)
        return

      case 'tool-call':
        this.endStreamingLine()
        this.output.write(
          `tool> ${sanitizeTerminalText(event.name)} (${sanitizeTerminalText(event.callId)}) ${sanitizeTerminalText(event.arguments)}\n`,
        )
        return

      case 'tool-result':
        this.endStreamingLine()
        this.output.write(
          `tool${event.isError ? '!' : '<'} ${sanitizeTerminalText(event.callId)} ${sanitizeTerminalText(event.text)}\n`,
        )
        return

      case 'subagent-started':
        this.endStreamingLine()
        this.output.write(
          `agent+ ${sanitizeTerminalText(event.childSessionId)} <- ${sanitizeTerminalText(event.parentSessionId)}${event.provider === undefined ? '' : ` [${sanitizeTerminalText(event.provider)}]`}\n`,
        )
        return

      case 'subagent-finished':
        this.endStreamingLine()
        this.output.write(`agent- ${sanitizeTerminalText(event.childSessionId)}\n`)
        return

      case 'turn-error':
        this.endStreamingLine()
        this.output.write(`error> ${sanitizeTerminalText(event.message)}\n`)
        return

      case 'session-status':
        if (event.status === 'idle') this.endStreamingLine()
        return

      case 'unknown':
        if (this.debugUnknownEvents) {
          this.endStreamingLine()
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
    this.endStreamingLine()
  }

  private renderCommittedAssistant(text: string): void {
    if (!this.assistantStreaming) {
      this.output.write(`assistant> ${sanitizeTerminalText(text)}\n`)
      return
    }

    if (text === this.streamedAssistantText) {
      this.output.write('\n')
    } else if (text.startsWith(this.streamedAssistantText)) {
      this.output.write(`${sanitizeTerminalText(text.slice(this.streamedAssistantText.length))}\n`)
    } else {
      this.output.write(`\nassistant(committed)> ${sanitizeTerminalText(text)}\n`)
    }

    this.assistantStreaming = false
    this.streamedAssistantText = ''
  }

  private endStreamingLine(): void {
    if (!this.assistantStreaming) return
    this.output.write('\n')
    this.assistantStreaming = false
    this.streamedAssistantText = ''
  }
}
