import { useEffect, useState, useSyncExternalStore } from 'react'

/** Compute updates before scheduling React, publish one immutable snapshot. */
export class SnapshotStore<T> {
  private listeners = new Set<() => void>()
  constructor(private value: T, private readonly canNotify: () => boolean = () => true) {}
  get = (): T => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  set = (update: T | ((previous: T) => T)): void => {
    const next = typeof update === 'function' ? (update as (previous: T) => T)(this.value) : update
    if (Object.is(this.value, next)) return
    this.value = next
    this.notify()
  }
  notify = (): void => { if (this.canNotify()) for (const listener of this.listeners) listener() }
}
export function useSnapshotState<T>(initial: T | (() => T), output?: NodeJS.WriteStream): [T, SnapshotStore<T>['set']] {
  const [store] = useState(() => new SnapshotStore(typeof initial === 'function' ? (initial as () => T)() : initial, () => !output?.writableNeedDrain))
  useEffect(() => {
    output?.on('drain', store.notify)
    return () => { output?.off('drain', store.notify) }
  }, [output, store])
  return [useSyncExternalStore(store.subscribe, store.get), store.set]
}
