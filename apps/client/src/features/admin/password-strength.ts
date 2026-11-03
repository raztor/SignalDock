/**
 * Pure password strength estimate for the new-user, password-reset and
 * first-administrator forms. Node-safe (no React Native imports).
 *
 * The backend is authoritative: it requires 12–1024 characters and nothing
 * else. This estimate only guides people toward long, unpredictable
 * passphrases; it never blocks a password the backend accepts beyond the
 * length rule.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export type PasswordLevel = 'too-short' | 'weak' | 'fair' | 'good' | 'strong';
export type PasswordTone = 'error' | 'warning' | 'primary';

export interface PasswordStrength {
  /** 0 = below the minimum; 1–4 = meter segments lit. */
  score: 0 | 1 | 2 | 3 | 4;
  level: PasswordLevel;
  label: string;
  hint: string;
  /** Satisfies the backend length rule. */
  acceptable: boolean;
  tone: PasswordTone;
  /** Rough entropy estimate in bits after penalties. */
  bits: number;
}

export const PASSWORD_LEVEL_LABELS: Record<PasswordLevel, string> = {
  'too-short': 'Too short',
  weak: 'Weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong',
};

/** Fragments that make a password predictable regardless of length. */
const COMMON_FRAGMENTS = [
  'password',
  'passw0rd', // ggignore: Password-estimator fixture or dictionary entry, not a credential.
  'qwerty',
  'azerty',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'signaldock',
  'iloveyou',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'master',
  'secret',
  'changeme',
  'contraseña',
  'contrasena',
  'radio',
  'abc123',
  '123456',
  '654321',
  '111111',
  '000000',
];

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
];

function characterPool(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9\s]/.test(password) && /[\x21-\x7e]/.test(password))
    pool += 33;
  if (/\s/.test(password)) pool += 1;
  // Accented letters and other scripts widen the pool considerably.
  if (/[^\x00-\x7f]/.test(password)) pool += 40;
  return Math.max(pool, 1);
}

export function characterClasses(password: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
}

/**
 * Length that counts toward entropy: runs of a repeated character and
 * keyboard/alphabet sequences of 3+ characters count as a single character.
 */
export function effectiveLength(password: string): number {
  const chars = Array.from(password.toLowerCase());
  let length = 0;
  let index = 0;
  while (index < chars.length) {
    let run = 1;
    const current = chars[index] ?? '';
    while (chars[index + run] === current) run += 1;
    if (run >= 3) {
      length += 1;
      index += run;
      continue;
    }
    let sequence = 1;
    for (const source of SEQUENCES) {
      const start = source.indexOf(current);
      if (start < 0) continue;
      for (const direction of [1, -1]) {
        let span = 1;
        while (
          chars[index + span] !== undefined &&
          chars[index + span] === source[start + direction * span]
        )
          span += 1;
        sequence = Math.max(sequence, span);
      }
    }
    if (sequence >= 3) {
      length += 1;
      index += sequence;
      continue;
    }
    length += 1;
    index += 1;
  }
  return length;
}

/**
 * Replaces each predictable fragment with one placeholder character so that it
 * counts as a single symbol of entropy. Longest fragments are matched first.
 */
function collapseFragments(
  lower: string,
  fragments: readonly string[],
): { text: string; found: boolean } {
  let text = lower;
  let found = false;
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) {
    if (!fragment || !text.includes(fragment)) continue;
    found = true;
    text = text.split(fragment).join('\u0000');
  }
  return { text, found };
}

function levelForBits(bits: number): 1 | 2 | 3 | 4 {
  if (bits < 50) return 1;
  if (bits < 64) return 2;
  if (bits < 80) return 3;
  return 4;
}

const LEVEL_BY_SCORE = ['too-short', 'weak', 'fair', 'good', 'strong'] as const;

/** Estimates the strength of `password`. `context` words (e.g. the username) count as predictable. */
export function passwordStrength(
  password: string,
  context: readonly string[] = [],
): PasswordStrength {
  // Measure exactly as the backend's zod `.min(12).max(1024)` does: UTF-16
  // code units (`string.length`), so the client never blocks a password the
  // server accepts.
  const length = password.length;
  if (length < PASSWORD_MIN_LENGTH)
    return result(0, 0, {
      hint: length
        ? `Use at least ${PASSWORD_MIN_LENGTH} characters (${
            PASSWORD_MIN_LENGTH - length
          } more).`
        : `Use at least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong passphrase.`,
      acceptable: false,
    });
  if (length > PASSWORD_MAX_LENGTH)
    return result(0, 0, {
      hint: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
      acceptable: false,
      label: 'Too long',
    });

  const lower = password.toLowerCase();
  const hints: string[] = [];
  const personal = collapseFragments(
    lower,
    context
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word.length >= 3),
  );
  if (personal.found) hints.push('Avoid using the username.');
  const common = collapseFragments(personal.text, COMMON_FRAGMENTS);
  if (common.found) hints.push('Avoid common words and passwords.');
  const effective = effectiveLength(common.text);
  let bits = effective * Math.log2(characterPool(password));
  const distinct = new Set(Array.from(lower)).size;
  // Code points (not UTF-16 units) for the variety and repetition estimates.
  const characters = Array.from(password).length;
  let cap = 4;
  if (distinct < Math.max(4, Math.ceil(characters / 4))) {
    cap = 1;
    hints.push('Use more different characters.');
  } else if (
    !personal.found &&
    !common.found &&
    effective < characters * 0.75
  ) {
    hints.push('Avoid repeated characters and sequences.');
  }

  bits = Math.max(0, Math.round(bits));
  const score = Math.min(levelForBits(bits), cap) as 1 | 2 | 3 | 4;
  if (score < 3 && !hints.length)
    hints.push(
      characterClasses(password) < 3 && characters < 16
        ? 'Add more words, or mix in capitals, digits or symbols.'
        : 'Add another word or a few more characters.',
    );
  if (score >= 3 && !hints.length)
    hints.push(
      score === 4
        ? 'Strong. Store it in a password manager.'
        : 'Good. A longer passphrase is even stronger.',
    );
  return result(score, bits, { hint: hints.join(' '), acceptable: true });
}

function result(
  score: 0 | 1 | 2 | 3 | 4,
  bits: number,
  options: { hint: string; acceptable: boolean; label?: string },
): PasswordStrength {
  const level = LEVEL_BY_SCORE[score];
  return {
    score,
    level,
    label: options.label ?? PASSWORD_LEVEL_LABELS[level],
    hint: options.hint,
    acceptable: options.acceptable,
    tone: score <= 1 ? 'error' : score === 2 ? 'warning' : 'primary',
    bits,
  };
}

/** Assistive-technology summary, e.g. "Password strength: Fair. Add …". */
export function passwordStrengthLabel(strength: PasswordStrength): string {
  return `Password strength: ${strength.label}. ${strength.hint}`;
}
