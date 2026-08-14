/**
 * Git branch watcher for the session cwd: polls `git rev-parse` every few
 * seconds and caches the result. Readers get O(1) access — the footer and the
 * editor top border never spawn git themselves during render.
 */

import { execFile } from 'node:child_process'

export class GitBranchWatcher {
  private readonly cwd: string
  private branch: string | undefined
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(cwd: string, intervalMs = 5000) {
    this.cwd = cwd
    this.timer = setInterval(() => { void this.refresh() }, intervalMs)
    this.timer.unref?.()
    void this.refresh()
  }

  getBranch(): string | undefined {
    return this.branch
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private async refresh(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const branch = await new Promise<string | undefined>(resolvePromise => {
        execFile('git', ['-C', this.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 }, (error, stdout) => {
          if (error !== null) return resolvePromise(undefined)
          const value = stdout.trim()
          resolvePromise(value === '' ? undefined : value)
        })
      })
      if (branch !== this.branch) {
        this.branch = branch
        this.onChange?.()
      }
    } finally {
      this.running = false
    }
  }

  /** Called when the branch value actually changed. */
  onChange: (() => void) | undefined
}
