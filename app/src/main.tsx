import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Landing } from './Landing'
// L'application charge le client du fournisseur: on ne la charge qu'à la demande,
// pour que la page d'accueil n'appelle jamais de service externe.
const App = lazy(() => import('./App').then((m) => ({ default: m.App })))
import './index.css'

// Routage par ancre: accueil (landing) et #app (application).
function Root() {
  // Le lien d'approbation d'appareil (?deviceRegistrationToken=...) arrive dans l'application.
  const [hash, setHash] = useState(() => (location.search.includes('deviceRegistrationToken') ? '#app' : location.hash))
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  if (hash === '#app')
    return (
      <Suspense fallback={null}>
        <App />
      </Suspense>
    )
  return <Landing />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
