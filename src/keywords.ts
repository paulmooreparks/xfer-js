/**
 * The bare words that are not symbols (specification 4.2). `-inf` is also a keyword, but it begins
 * with `-`, which no identifier may, so it is lexed as a number and is not listed here.
 */
export const KEYWORDS: ReadonlySet<string> = new Set(["true", "false", "null", "inf", "nan"]);
