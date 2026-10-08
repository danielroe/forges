const MANAGED = 'data-scroll-focus'

/** Makes a scrollable region keyboard focusable while its content overflows, and only then. */
export function syncScrollable(element: HTMLElement) {
  const overflows = (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
    && !element.querySelector('a[href], button, input, select, textarea, [tabindex]:not([data-scroll-focus])')
  if (overflows && !element.hasAttribute('tabindex')) {
    element.setAttribute('tabindex', '0')
    element.setAttribute(MANAGED, '')
  }
  else if (!overflows && element.hasAttribute(MANAGED)) {
    element.removeAttribute('tabindex')
    element.removeAttribute(MANAGED)
  }
}
