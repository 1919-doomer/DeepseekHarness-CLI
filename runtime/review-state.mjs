// Sessions the terminal opened to review another session's work.
//
// A reviewer reads; it never changes anything. The terminal registers the
// session id over its token-authenticated loopback channel before the first
// prompt, so the policy narrows the agent the moment it is created. Nothing a
// model can call adds to this set, and nothing removes a session from it.

/** What a reviewer may call. The smallest set upstream allows: an empty restriction is an error. */
export const REVIEW_TOOLS = Object.freeze(['read', 'glob', 'grep'])

/** Bounded so a long session cannot grow it without limit; the oldest id goes first. */
const MAX_REVIEWERS = 1024
const reviewers = new Set()

export const reviewState = {
  register(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) return false
    if (reviewers.size >= MAX_REVIEWERS) reviewers.delete(reviewers.values().next().value)
    reviewers.add(id)
    return true
  },
  has(id) {
    return typeof id === 'string' && reviewers.has(id)
  },
}
