/**
 * Merchant name helpers: pure string functions, no Supabase dependencies.
 */

/**
 * Normalize a merchant name for comparison.
 * Removes special characters, Swedish company suffixes, and extra whitespace.
 */
export function normalizeMerchantName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\såäöé]/g, '') // Remove special chars except Swedish letters
    .replace(/\b(ab|hb|kb|ek|för|stiftelse)\b/g, '') // Remove company suffixes
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Calculate Levenshtein (edit) distance between two strings.
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length
  const n = str2.length

  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      )
    }
  }

  return dp[m][n]
}
