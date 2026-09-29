// Avatar initial: a colour circle + one character. Pure, unit tested.

/** Default names end in a digit ("담당자 3") — the digit tells the four apart; otherwise the first character. */
export function initialOf(name) {
  const clean = String(name ?? "").trim();
  if (!clean) return "?";
  const digit = clean.match(/(\d)\s*$/);
  if (digit) return digit[1];
  return Array.from(clean)[0].toUpperCase(); // Array.from keeps emoji / surrogate pairs whole
}
