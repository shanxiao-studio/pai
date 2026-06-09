import { spawn } from 'child_process'
import { DotagentsHook } from '../../core/models'

export class HookRunner {
  async run(params: {
    projectPath: string
    hooks: DotagentsHook[]
    event: string
    agentKind: string
  }) {
    const matchingHooks = params.hooks.filter((hook) => {
      if (hook.event !== params.event) return false
      if (!hook.matcher?.trim()) return true
      return hook.matcher.trim() === params.agentKind
    })

    const results: Array<{ command: string; code: number | null; stdout: string; stderr: string }> = []
    for (const hook of matchingHooks) {
      results.push(await this.runOne(params.projectPath, hook.command))
    }
    return results
  }

  private runOne(projectPath: string, command: string) {
    return new Promise<{ command: string; code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(command, {
        cwd: projectPath,
        env: { ...process.env },
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      proc.on('error', reject)
      proc.on('close', (code) => {
        resolve({ command, code, stdout, stderr })
      })
    })
  }
}
