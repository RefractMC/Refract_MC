import { useEffect } from 'react'

// Modals are rendered inside the main scroll container, so scrolling within them
// chains to the page behind. While any modal is mounted, freeze the app scroller
// (see `body.modal-open .app-scroll` in globals.css). Reference-counted so
// stacked modals don't unlock early.
let openCount = 0

export function useScrollLock(): void {
  useEffect(() => {
    openCount++
    document.body.classList.add('modal-open')
    return () => {
      openCount = Math.max(0, openCount - 1)
      if (openCount === 0) document.body.classList.remove('modal-open')
    }
  }, [])
}
