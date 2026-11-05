import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAccess } from '../access/AccessProvider'
import { explain } from '../access/errors'
import type { ChainData } from '../bank/api'
import type { Chain } from '../provider/types'

/* Soldes et historique des trois réseaux de test, lus par la banque chez les explorateurs publics.
   Une seule instance pour toute l'application: les écrans lisent le même état au lieu de relancer chacun leurs requêtes. */

const POLL_MS = 30_000

type State = {
  data: Partial<Record<Chain, ChainData>>
  errors: Partial<Record<Chain, string>>
  loading: boolean
  refresh: () => Promise<void>
}

const Ctx = createContext<State | null>(null)

export function useChainData(): State {
  const v = useContext(Ctx)
  if (!v) throw new Error('useChainData must be used inside <ChainProvider>')
  return v
}

export function ChainProvider({ children }: { children: ReactNode }) {
  const a = useAccess()
  const accounts = a.snapshot.accounts
  const [data, setData] = useState<State['data']>({})
  const [errors, setErrors] = useState<State['errors']>({})
  const [loading, setLoading] = useState(false)
  const inflight = useRef(false)
  const key = accounts.map((x) => x.chain + x.address).join('|')
  const read = a.bank.readChain

  const refresh = useCallback(async () => {
    if (inflight.current || accounts.length === 0) return
    inflight.current = true
    setLoading(true)
    const results = await Promise.allSettled(accounts.map((x) => read(x.chain, x.address)))
    const nextData: State['data'] = {}
    const nextErrors: State['errors'] = {}
    results.forEach((r, i) => {
      const chain = accounts[i].chain
      if (r.status === 'fulfilled') nextData[chain] = r.value
      else nextErrors[chain] = explain(r.reason).message
    })
    // Une lecture ratée n'efface pas la dernière valeur connue: on garde l'ancienne et on signale l'erreur.
    setData((prev) => ({ ...prev, ...nextData }))
    setErrors(nextErrors)
    setLoading(false)
    inflight.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, read])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const value = useMemo(() => ({ data, errors, loading, refresh }), [data, errors, loading, refresh])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
