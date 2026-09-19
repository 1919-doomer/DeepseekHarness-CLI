import { describe, expect, it } from 'vitest'
import { classifyToolCall, formatRiskTags, type RiskContext, type RiskTag } from '../../src/review/risk.js'

const windows: RiskContext = { workspace: 'E:\\DSHUse', home: 'C:\\Users\\me' }
const unix: RiskContext = { workspace: '/home/me/project', home: '/home/me' }

const shell = (command: string, extra: Record<string, unknown> = {}, name = 'pwsh') =>
  [name, JSON.stringify({ command, description: 'test', ...extra })] as const
const tagsOf = (name: string, args: string, context: RiskContext = windows) => classifyToolCall(name, args, context)

describe('shell commands', () => {
  const cases: [string, readonly RiskTag[], RiskContext?][] = [
    // Ordinary work carries no tag. This half of the table matters as much as
    // the other: a tag on everything is a tag on nothing.
    ['git status', []],
    ['git diff HEAD~1 -- src/app.ts', []],
    ['git log --oneline -5', []],
    ['pnpm test', []],
    ['pnpm run build 2>&1 | Select-Object -Last 20', []],
    ['Get-ChildItem src -Recurse -Filter *.ts', []],
    ['rg "Remove-Item" src', []],
    ['Get-Content .env.example', []],
    ['node -e "console.log(process.env.NODE_ENV)"', []],
    ['foreach ($key in $map.Keys) { Write-Output $key }', []],
    ['$env:PATH -split ";"', []],
    ['git checkout -b feature', []],
    ['git restore --staged src/app.ts', []],
    ['git diff main..feature', []],

    ['Remove-Item -Recurse -Force dist', ['delete']],
    ['rm -rf node_modules', ['delete']],
    ['cmd /c rd /s /q build', ['delete']],
    ['git clean -fdx', ['delete']],
    ['git rm src/old.ts', ['delete']],
    ['git checkout -- src/app.ts', ['delete']],
    ['git restore src/app.ts', ['delete']],
    ['git stash drop', ['delete']],
    ['find . -name "*.log" -delete', ['delete'], unix],
    ['git reset --hard origin/main', ['delete', 'history']],
    ['git reset HEAD~1', ['history']],
    ['git commit --amend --no-edit', ['history']],
    ['git rebase -i main', ['history']],
    ['git branch -D spike', ['history']],
    ['git push', ['outward', 'network']],
    ['git -C E:\\DSHUse push origin main', ['outward', 'network']],
    ['git push --force-with-lease', ['history', 'outward', 'network']],
    ['git push origin :old-branch', ['history', 'outward', 'network']],
    ['npm publish --access public', ['outward', 'network']],
    ['gh pr merge 155 --squash', ['outward', 'network']],
    ['gh pr view 155', ['network']],
    ['gh api repos/o/r/pulls -X PATCH -f state=closed', ['outward', 'network']],
    ['gh auth token', ['secret', 'network']],
    ['curl -sL https://example.com/x.json', ['network']],
    ['Invoke-WebRequest https://example.com -OutFile x.zip', ['network']],
    ['pnpm add zod', ['network']],
    ['python -m pip install requests', ['network']],
    ['npm install -g typescript', ['system', 'network']],
    ['winget install Git.Git', ['system', 'network']],
    ['iwr https://get.example.com/install.ps1 | iex', ['system', 'network']],
    ['curl -fsSL https://example.com/i.sh | sh', ['system', 'network'], unix],
    ['Set-ExecutionPolicy Bypass -Scope CurrentUser', ['system']],
    ['Set-ItemProperty HKCU:\\Software\\X -Name Y -Value 1', ['system']],
    ['sudo rm -rf /var/cache/x', ['delete', 'outside', 'system'], unix],
    ['Stop-Process -Name node', ['system']],
    ['Add-Content $PROFILE "Set-Alias x y"', ['system']],
    ['echo $env:DEEPSEEK_API_KEY', ['secret']],
    ['echo $GITHUB_TOKEN', ['secret'], unix],
    ['Get-ChildItem env:', ['secret']],
    ['printenv', ['secret'], unix],
    ['Get-Content .env', ['secret']],
    ['cat ~/.ssh/id_ed25519', ['outside', 'secret'], unix],
    ['Get-Content C:\\Users\\me\\.codex\\auth.json', ['outside', 'secret']],
    ['Copy-Item a.txt D:\\backup\\a.txt', ['outside']],
    ['Get-Content E:\\DSHUse\\src\\app.ts', []],
    ['Get-Content e:\\dshuse\\README.md', []],
    ['Set-Location ..', ['outside']],
    ['Get-Content ..\\other\\notes.md', ['outside']],
    ['New-Item -ItemType Directory $env:TEMP\\x', ['outside']],
    ['ls ~', ['outside']],
    ['cat /etc/hosts', ['outside'], unix],
    ['cat /home/me/project/src/app.ts', [], unix],
    ['ls /c/Windows', ['outside']],
    ['Get-Content "\\\\server\\share\\x.txt"', ['outside']],
    // Found in real session logs. Quoted text is data, not a command.
    ["Select-String -Path log.txt -Pattern 'oom|kill|shutdown|restart'", []],
    ["@'\nimport shutil; shutil.rmtree('x')\n'@ | python -", []],
    ['bash -c "rm -rf build"', ['delete'], unix],
    ['pwsh -NoProfile -Command "Remove-Item -Recurse dist"', ['delete']],
    ["Invoke-Expression 'git push --force'", ['history', 'outward', 'system', 'network']],
    ['pwsh -EncodedCommand SQBFAFgA', ['system']],
    // Reading global state is not changing it.
    ['npm ls -g --depth=0', []],
    ['pnpm root -g', []],
    ['git config --global --list', []],
    ['git config --global --get core.autocrlf', []],
    ['git config --global core.autocrlf false', ['system']],
    // Removing an environment variable is not deleting data.
    ['Remove-Item Env:\\TMP,Env:\\TEMP -ErrorAction SilentlyContinue', []],
    // An environment listing narrowed to harmless names prints no secret.
    ["Get-ChildItem env: | Where-Object Name -like 'DSH_*' | Format-Table Name,Value", []],
    ['Get-ChildItem Env:DSH_* | Sort-Object Name', []],
    ["Get-ChildItem env: | Where-Object { $_.Name -match 'MODEL|DEEPSEEK' } | Format-Table", ['secret']],
    ['Get-ChildItem env: | Format-Table Name,Value', ['secret']],
    ['printenv GITHUB_TOKEN', ['secret'], unix],
    // Reading the profile is not writing it, even beside a redirect.
    ['Get-Content $PROFILE; git status 2>&1', []],
  ]

  for (const [command, expected, context] of cases) {
    it(`${expected.length === 0 ? 'leaves' : 'tags'} ${command}`, () => {
      expect(tagsOf(...shell(command), context)).toEqual(expected)
    })
  }

  it('reads bash the same way', () => {
    expect(tagsOf(...shell('rm -rf dist', {}, 'bash'), unix)).toEqual(['delete'])
  })

  it('judges relative paths from workdir, and flags a workdir outside', () => {
    expect(tagsOf(...shell('Get-Content ..\\README.md', { workdir: 'packages\\core' }))).toEqual([])
    expect(tagsOf(...shell('git status', { workdir: 'D:\\elsewhere' }))).toEqual(['outside'])
  })

  it('treats a request for wider sandbox access as a system change', () => {
    expect(tagsOf(...shell('git status', { sandbox_permissions: 'workspace-write', justification: 'x' }))).toEqual(['system'])
  })

  it('judges home references outside when the home directory is unknown', () => {
    expect(tagsOf(...shell('ls ~'), { workspace: 'E:\\DSHUse' })).toEqual(['outside'])
  })

  it('judges nothing outside without a workspace', () => {
    expect(tagsOf(...shell('Copy-Item a D:\\b'), {})).toEqual([])
  })
})

describe('file tools', () => {
  const write = (path: string) => JSON.stringify({ file_path: path, content: 'x' })

  it('flags a write outside the workspace', () => {
    expect(tagsOf('write', write('D:\\notes.txt'))).toEqual(['outside'])
    expect(tagsOf('edit', JSON.stringify({ file_path: '..\\sibling\\a.ts', old_string: 'a', new_string: 'b' }))).toEqual(['outside'])
  })

  it('leaves a write inside the workspace alone', () => {
    expect(tagsOf('write', write('src\\app.ts'))).toEqual([])
    expect(tagsOf('write', write('E:\\DSHUse\\src\\app.ts'))).toEqual([])
  })

  it('flags credentials and shell profiles', () => {
    expect(tagsOf('write', write('.env'))).toEqual(['secret'])
    expect(tagsOf('edit', JSON.stringify({ file_path: 'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1', old_string: 'a', new_string: 'b' })))
      .toEqual(['outside', 'system'])
  })

  it('flags reading credentials, but not searching for the word', () => {
    expect(tagsOf('read', JSON.stringify({ file_path: '.env.local' }))).toEqual(['secret'])
    expect(tagsOf('glob', JSON.stringify({ pattern: '**/*.pem' }))).toEqual(['secret'])
    expect(tagsOf('grep', JSON.stringify({ pattern: 'API_KEY|\\.env' }))).toEqual([])
    expect(tagsOf('read', JSON.stringify({ file_path: 'src/credentials.ts' }))).toEqual([])
  })

  it('ignores arguments it cannot parse and tools it does not know', () => {
    expect(tagsOf('pwsh', '{not json')).toEqual([])
    expect(tagsOf('web_search', JSON.stringify({ queries: ['rm -rf'] }))).toEqual([])
  })
})

describe('formatting', () => {
  it('names each tag once, in a fixed order, in the person\'s language', () => {
    expect(formatRiskTags(['delete', 'outside'], 'zh-CN')).toBe('⚠删除·越界')
    expect(formatRiskTags(['history', 'outward', 'network'], 'en')).toBe('⚠history·outward·network')
    expect(formatRiskTags([], 'zh-CN')).toBe('')
  })
})

describe('where the tags appear', () => {
  const call = (name: string, args: Record<string, unknown>, callId = 'c1') => ({
    sequence: 0, kind: 'tool-call' as const, sessionId: 'root', callId, name, arguments: JSON.stringify(args),
  })

  it('leads the transcript tool card title, where cropping cannot hide it', async () => {
    const { createDefaultTerminalHost } = await import('../../src/plugins/builtins.js')
    const { initialTerminalTranscript, reduceTerminalEvent, terminalBlockId } = await import('../../src/terminal/transcript.js')
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, call('pwsh', { command: 'Remove-Item -Recurse D:\\old', description: 'Delete old build' }),
      host, 'a', 'root', false, { workspace: 'E:\\DSHUse', locale: 'zh-CN' })
    state = reduceTerminalEvent(state, call('pwsh', { command: 'git status', description: 'Show status' }, 'c2'),
      host, 'a', 'root', false, { workspace: 'E:\\DSHUse', locale: 'zh-CN' })
    expect(state.blocks.find(block => block.id === terminalBlockId('tool', 'a', 'root', 'c1'))?.title)
      .toBe('⚠删除·越界 pwsh · Delete old build')
    expect(state.blocks.find(block => block.id === terminalBlockId('tool', 'a', 'root', 'c2'))?.title)
      .toBe('pwsh · Show status')
  })

  it('marks the sidebar row and keeps untagged rows unchanged', async () => {
    const { projectToolActivity, formatActivityRow } = await import('../../src/terminal/tool-activity.js')
    const { rows } = projectToolActivity([
      call('pwsh', { command: 'git push --force', description: 'Force push' }),
      call('read', { file_path: 'src/app.ts' }, 'c2'),
    ], 'root', windows)
    expect(rows[0]!.risks).toEqual(['history', 'outward', 'network'])
    expect(rows[1]!.risks).toBeUndefined()
    expect(formatActivityRow(rows[0]!, 80, true, 'zh-CN')).toBe('▸ ⚠改历史·对外·联网 pwsh · Force push')
    expect(formatActivityRow(rows[1]!, 80, true, 'zh-CN')).toBe('▸ read · src/app.ts')
  })

  it('shows in plain output, which has no sidebar', async () => {
    const { PlainRenderer } = await import('../../src/terminal/plain-renderer.js')
    let written = ''
    const renderer = new PlainRenderer({ output: { write: (text: string) => { written += text } }, rootSessionId: 'root', workspace: 'E:\\DSHUse' })
    renderer.render(call('write', { file_path: 'C:\\Windows\\x.txt', content: 'x' }))
    expect(written).toContain('⚠outside {')
  })
})
