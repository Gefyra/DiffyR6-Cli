/**
 * Strips HTML tags from a string
 */
export function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Normalizes whitespace in a string
 */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Decodes HTML entities
 */
export function decodeEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
  };
  return text.replace(/&[#a-z0-9]+;/gi, (match) => entities[match.toLowerCase()] || match);
}
