/**
 * Ambient types for the Hermes Desktop plugin SDK.
 *
 * `@hermes/plugin-sdk` is resolved by the Desktop renderer's import map, not
 * by npm — it exists only inside the app. These declarations describe the
 * slice of the SDK this plugin uses, so `tsc --noEmit` type-checks the
 * plugin the way the app's own loader will run it. The shapes mirror
 * `apps/desktop/src/sdk/index.ts` in the Hermes Agent repository.
 */

declare module '@hermes/plugin-sdk' {
  import type { ReactNode } from 'react'

  /** A readonly view over one of the app's live state atoms. */
  export interface ReadableAtom<T> {
    get(): T
    subscribe(listener: (value: T, oldValue: T) => void): () => void
  }

  /** The app's live state, as readonly atoms. */
  export const host: {
    readonly state: {
      readonly profile: ReadableAtom<string>
      readonly model: ReadableAtom<string>
      readonly gateway: ReadableAtom<string>
      readonly busy: ReadableAtom<boolean>
      readonly focusedSessionId: ReadableAtom<string | null>
      readonly focusedStoredSessionId: ReadableAtom<string | null>
      readonly focusedSessionProfile: ReadableAtom<string>
    }
    notify(options: { kind: 'info' | 'error' | 'success' | 'warning'; message: string; title?: string }): unknown
    notifyError(error: unknown, fallbackMessage?: string): unknown
    navigate(path: string): void
    request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
    openSession(
      storedSessionId: string,
      options?: {
        expectHistory?: boolean
        keepAllProfilesScope?: boolean
        profile?: string | null
        awaitHydration?: boolean
        intent?: 'in-place' | 'stack' | 'tab' | 'window'
      }
    ): Promise<void>
    newChat(profile?: string | null): void
  }

  /** Contribution area ids. */
  export const STATUSBAR_AREAS: { left: 'statusBar.left'; right: 'statusBar.right' }
  export const PALETTE_AREA: 'palette'
  export const KEYBINDS_AREA: 'keybinds'
  export const PANES_AREA: 'panes'

  /** A React component the app exports from its own UI kit. */
  export const Badge: (props: {
    children?: ReactNode
    className?: string
    variant?: 'default' | 'muted' | 'success' | 'warn' | 'destructive' | 'outline' | 'solid'
    size?: 'default' | 'xs' | 'overlay'
  }) => ReactNode

  export const Codicon: (props: {
    name: string
    size?: string
    className?: string
    title?: string
  }) => ReactNode

  /** A nanostores atom, re-exported by the SDK. */
  export function atom<T>(initial: T): {
    get(): T
    set(value: T): void
    subscribe(listener: (value: T, oldValue: T) => void): () => void
  }

  /**
   * A nanostores computed store: derived from one or more atoms and
   * recomputed only when a dependency changes. The derive function receives
   * the dependency values in the same order the stores were passed.
   */
  export function computed<A, T>(
    stores: readonly [{ get(): A; subscribe(listener: (value: A, oldValue: A) => void): () => void }],
    derive: (a: A) => T
  ): { get(): T; subscribe(listener: (value: T, oldValue: T) => void): () => void }

  export function computed<A, B, T>(
    stores: readonly [
      { get(): A; subscribe(listener: (value: A, oldValue: A) => void): () => void },
      { get(): B; subscribe(listener: (value: B, oldValue: B) => void): () => void }
    ],
    derive: (a: A, b: B) => T
  ): { get(): T; subscribe(listener: (value: T, oldValue: T) => void): () => void }

  /** The app's single React Query client, plus the hooks over it. */
  export function useQuery<T>(options: {
    queryKey: readonly unknown[]
    queryFn: () => Promise<T>
    staleTime?: number
    refetchInterval?: number
    retry?: number
  }): {
    data: T | undefined
    isLoading: boolean
    isFetching: boolean
    error: unknown
    refetch(): Promise<unknown>
  }

  /** Subscribe a component to a nanostores atom. */
  export function useValue<T>(atom: { get(): T; subscribe(listener: (value: T, oldValue: T) => void): () => void }): T
}
