import { randomUUID } from 'node:crypto'

/**
 * Review sessions are named apart from conversations so `/history` can leave
 * them out and `dshc logs` can label them: nobody talked in them.
 */
export const REVIEW_SESSION_PREFIX = 'review-'

export function createReviewSessionId(): string {
  return `${REVIEW_SESSION_PREFIX}${randomUUID().replaceAll('-', '')}`
}

export function isReviewSessionId(id: string): boolean {
  return id.startsWith(REVIEW_SESSION_PREFIX)
}
