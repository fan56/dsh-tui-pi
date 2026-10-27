const cancelled = (): Error => Object.assign(new Error('Dialog cancelled'), { name: 'AbortError' })

/** Serialize capturing dialogs and cancel outstanding work on teardown. */
export class DialogQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly pending = new Set<AbortController>()
  private closed = false

  run<T>(open: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(cancelled())
    const controller = new AbortController()
    this.pending.add(controller)
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const result = new Promise<T>((resolve, reject) => {
      const cancel = (): void => reject(cancelled())
      controller.signal.addEventListener('abort', cancel, { once: true })
      const task = this.tail.then(async () => {
        if (controller.signal.aborted) return
        try { resolve(await open(controller.signal)) } catch (error) { reject(error) }
      }).finally(() => {
        controller.signal.removeEventListener('abort', cancel)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(controller)
      })
      this.tail = task.catch(() => {})
    })
    return result
  }

  dispose(): void {
    this.closed = true
    for (const controller of this.pending) controller.abort()
  }
}
