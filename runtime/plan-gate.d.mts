/** Tool names that wait for a declared plan in code mode. */
export declare const GATED_TOOLS: ReadonlySet<string>

export interface PlanGateQuery {
  name: string
  mode: string
  planDeclared: boolean
  planToolAvailable: boolean
  isChild: boolean
}

export interface PlanGateDecision {
  allow: boolean
  reason?: string
  denials?: number
}

export declare function decideToolCall(query: PlanGateQuery): PlanGateDecision

export declare class PlanGate {
  enable(): void
  readonly available: boolean
  declare(agentId: string): void
  reset(agentId: string): void
  markChild(agentId: string): void
  forget(agentId: string): void
  seed(agentId: string): void
  check(agentId: string, name: string, options: { mode: string; planToolAvailable: boolean }): PlanGateDecision
  denials(agentId: string): number
}

export declare const planGate: PlanGate
