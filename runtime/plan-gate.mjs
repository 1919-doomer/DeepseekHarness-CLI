/**
 * The plan gate: in code mode, nothing changes the world until the model has
 * said what it is about to change.
 *
 * A persona line asks; this enforces. Asked to compare three files, the model
 * read all three and never called `outline_plan` — the instruction was there
 * and did nothing, which is what "advisory" means in practice.
 *
 * State lives here rather than in either plugin because the tool that satisfies
 * the gate (`outline_plan`, in the interaction plugin) and the guard that
 * enforces it (in the mode policy) are separate Cordis plugins sharing one
 * module instance in the runtime process.
 *
 * The rule is deliberately narrow. Observing is always free — you cannot plan
 * what you have not looked at — and only calls that change something wait.
 */

/** Calls that change the world, and therefore wait for a declared plan. */
export const GATED_TOOLS = new Set(['write', 'edit', 'pwsh', 'bash', 'subagent'])

/**
 * Decide one call. Pure, so the rule can be tested as a table rather than by
 * standing up a runtime.
 */
export function decideToolCall({ name, mode, planDeclared, planToolAvailable, isChild }) {
  // Other modes are already read-only; there is nothing here to gate.
  if (mode !== 'code') return { allow: true }
  // Fail open when the tool that satisfies the gate does not exist. The
  // interaction channel is optional, and a runtime whose only escape hatch is
  // unregistered would be a brick rather than a strict one.
  if (!planToolAvailable) return { allow: true }
  // A subagent is executing one step of a plan its parent already declared.
  // Making every child re-plan costs a call and buries the parent's plan.
  if (isChild) return { allow: true }
  if (!GATED_TOOLS.has(name)) return { allow: true }
  if (planDeclared) return { allow: true }
  return {
    allow: false,
    reason: `dshc requires a plan before ${name} changes anything. Call outline_plan once with two to six short steps describing what you are about to do, then retry.`,
  }
}

/** Per-agent gate state for one runtime. */
export class PlanGate {
  #available = false
  #declared = new Set()
  #seeded = new Set()
  #children = new Set()
  #denials = new Map()

  /** The interaction plugin calls this once it has registered `outline_plan`. */
  enable() { this.#available = true }
  get available() { return this.#available }

  /** Called when `outline_plan` runs: this agent may now change things. */
  declare(agentId) { this.#declared.add(agentId) }

  /**
   * A new turn started, so the previous turn's plan no longer covers it.
   *
   * A seeded plan survives exactly one reset. Seeding happens at agent creation
   * and the first turn's `running` transition arrives immediately afterwards,
   * so without this the approved plan is wiped before the turn it was meant to
   * cover ever runs.
   */
  reset(agentId) {
    this.#denials.delete(agentId)
    if (this.#seeded.delete(agentId)) return
    this.#declared.delete(agentId)
  }

  /** Record a subagent, which the gate does not apply to. */
  markChild(agentId) { if (this.#children.size < 4096) this.#children.add(agentId) }

  forget(agentId) { this.#declared.delete(agentId); this.#seeded.delete(agentId); this.#children.delete(agentId); this.#denials.delete(agentId) }

  /**
   * Seed a plan approved in plan mode, so the handoff into code mode does not
   * demand the plan the person just approved be restated.
   */
  seed(agentId) { this.declare(agentId); this.#seeded.add(agentId) }

  /**
   * Decide, and count denials so a model that will not comply becomes visible
   * to the person instead of silently looping. Repeated denial never becomes
   * permission: the count is reported, not spent.
   */
  check(agentId, name, { mode, planToolAvailable }) {
    const decision = decideToolCall({
      name,
      mode,
      planDeclared: this.#declared.has(agentId),
      planToolAvailable,
      isChild: this.#children.has(agentId),
    })
    if (decision.allow) return decision
    const denials = (this.#denials.get(agentId) ?? 0) + 1
    this.#denials.set(agentId, denials)
    return { ...decision, denials }
  }

  denials(agentId) { return this.#denials.get(agentId) ?? 0 }
}

/** One gate per runtime process, shared by the plugins that read and write it. */
export const planGate = new PlanGate()
