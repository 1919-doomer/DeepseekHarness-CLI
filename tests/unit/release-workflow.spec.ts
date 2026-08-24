import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url)

describe('public alpha recovery workflow', () => {
  it('treats the tested tarball as a file and rebuilds an immutable input tag', async () => {
    const workflow = await readFile(workflowUrl, 'utf8')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('RELEASE_TAG: ${{ inputs.tag || github.ref_name }}')
    expect(workflow).toContain('ref: ${{ env.RELEASE_TAG }}')
    expect(workflow).toContain('npm stage publish ./package-artifact/*.tgz')
    expect(workflow).not.toContain('npm stage publish package-artifact/*.tgz')
    expect(workflow).toContain('test "${DRAFT}" = "true"')
    expect(workflow).toContain('gh release upload "${RELEASE_TAG}"')
  })
})
