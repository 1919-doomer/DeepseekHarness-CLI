import { randomUUID } from 'node:crypto'

export interface InteractiveSessionSnapshot {
  sessionId: string
  turnCount: number
  sessionGeneration: number
}

export class InteractiveSessionState {
  private currentSessionId: string
  private turnCountValue = 0
  private generationValue = 1

  constructor(initialSessionId?: string) {
    this.currentSessionId = initialSessionId ?? createSessionId()
  }

  get sessionId(): string {
    return this.currentSessionId
  }

  get turnCount(): number {
    return this.turnCountValue
  }

  get sessionGeneration(): number {
    return this.generationValue
  }

  recordCompletedTurn(): void {
    this.turnCountValue++
  }

  newSession(): string {
    this.currentSessionId = createSessionId()
    this.turnCountValue = 0
    this.generationValue++
    return this.currentSessionId
  }

  snapshot(): InteractiveSessionSnapshot {
    return {
      sessionId: this.currentSessionId,
      turnCount: this.turnCountValue,
      sessionGeneration: this.generationValue,
    }
  }
}

export function createSessionId(): string {
  return `session-${randomUUID().replaceAll('-', '')}`
}
