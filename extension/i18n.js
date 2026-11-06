// Edge resolves messages from its UI locale, then the manifest default locale.
// Page language and Accept-Language never override the browser's UI language.
let fallbackMessages;
// Offscreen documents expose runtime only. Their trusted background sends a
// small catalog already resolved with native i18n, including substitution slots.
export function setFallbackMessages(messages) {
  if (messages && typeof messages === 'object') fallbackMessages = messages;
}
export function t(key, substitutions = []) {
  const values = substitutions.map(String);
  return globalThis.chrome?.i18n?.getMessage(key, values) ||
    fallbackMessages?.[key]?.replace(/\$([1-9])/g, (_, n) => values[Number(n) - 1] ?? '') || key;
}

export function localizeDocument(root = document) {
  root.documentElement.lang = t('documentLanguage');
  root.documentElement.dir = 'ltr';
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['aria-label', 'title', 'alt', 'placeholder']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
