// Accessibility fixes for Docus markup that its components cannot configure.
function patch() {
  // Scrollable code blocks and tables are keyboard focusable.
  for (const element of document.querySelectorAll('pre, .overflow-x-auto')) {
    if (element.scrollWidth > element.clientWidth && !element.hasAttribute('tabindex')) {
      element.setAttribute('tabindex', '0')
    }
  }

  // The icon-only copy menu button gets a label.
  for (const button of document.querySelectorAll('button[aria-haspopup="menu"]')) {
    if (!button.textContent?.trim() && !button.hasAttribute('aria-label')) {
      button.setAttribute('aria-label', 'More ways to copy this page')
    }
  }

  // Navigation landmarks get labels.
  for (const nav of document.querySelectorAll('nav:not([aria-label]):not([aria-labelledby])')) {
    if (nav.closest('aside')) {
      nav.setAttribute('aria-label', 'Documentation')
    }
    else if (nav.classList.contains('sticky')) {
      nav.setAttribute('aria-label', 'On this page')
    }
  }

  // A separator that holds links drops its role.
  for (const separator of document.querySelectorAll('[role="separator"]')) {
    if (separator.querySelector('a, button')) {
      separator.setAttribute('role', 'presentation')
    }
  }
}

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('app:mounted', () => nextTick(patch))
  nuxtApp.hook('page:finish', () => nextTick(patch))
})
