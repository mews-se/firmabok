/**
 * Encoding detection and conversion for Swedish import files.
 *
 * Used by the supplier, customer and opening-balance parsers.
 * Swedish data exports use either UTF-8 or Windows-1252 (ISO-8859-1).
 * We detect encoding by checking for valid Swedish characters.
 */

/**
 * Decode file content, handling both UTF-8 and Windows-1252 encodings.
 *
 * Strategy: Try UTF-8 first. If the result contains replacement characters
 * (U+FFFD) or garbled Swedish chars, fall back to Windows-1252.
 */
export function decodeFileContent(buffer: ArrayBuffer): string {
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  const utf8Result = utf8Decoder.decode(buffer)

  if (!hasEncodingIssues(utf8Result)) {
    return utf8Result
  }

  const latin1Decoder = new TextDecoder('windows-1252', { fatal: false })
  return latin1Decoder.decode(buffer)
}

/**
 * Check if a string has encoding issues (garbled Swedish characters).
 */
export function hasEncodingIssues(text: string): boolean {
  if (text.includes('\uFFFD')) return true

  // Common garbled patterns when Windows-1252 is read as UTF-8:
  // Ã¥ = å, Ã¤ = ä, Ã¶ = ö, Ã… = Å, Ã„ = Ä, Ã– = Ö
  const garbledPatterns = ['Ã¥', 'Ã¤', 'Ã¶', 'Ã\u0085', 'Ã\u0084', 'Ã\u0096']
  return garbledPatterns.some((pattern) => text.includes(pattern))
}
