import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  characterClasses,
  effectiveLength,
  passwordStrength,
  passwordStrengthLabel,
} from './password-strength';

describe('passwordStrength', () => {
  it('rejects passwords below the backend minimum', () => {
    const empty = passwordStrength('');
    expect(empty).toMatchObject({
      score: 0,
      level: 'too-short',
      acceptable: false,
      tone: 'error',
    });
    expect(empty.hint).toContain(`at least ${PASSWORD_MIN_LENGTH}`);
    const short = passwordStrength('abc12');
    expect(short.acceptable).toBe(false);
    expect(short.hint).toContain('(7 more)');
  });

  it('accepts exactly 12 characters', () => {
    expect(passwordStrength('kdjfmgzpqnwl').acceptable).toBe(true); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
    expect(passwordStrength('kdjfmgzpqnw').acceptable).toBe(false); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
  });

  it('rejects passwords above the backend maximum', () => {
    const long = passwordStrength('ab'.repeat(PASSWORD_MAX_LENGTH));
    expect(long).toMatchObject({ acceptable: false, label: 'Too long' });
  });

  it('measures the minimum in UTF-16 units, exactly like the backend', () => {
    // Six emoji are 12 UTF-16 code units: zod `.min(12)` accepts them.
    expect(passwordStrength('🙂'.repeat(6)).acceptable).toBe(true);
    const five = passwordStrength('🙂'.repeat(5));
    expect(five.acceptable).toBe(false);
    expect(five.hint).toContain('(2 more)');
  });

  it('rates repeated characters and sequences as weak', () => {
    expect(passwordStrength('aaaaaaaaaaaa').level).toBe('weak');
    expect(passwordStrength('abcdefghijkl').level).toBe('weak'); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
    expect(passwordStrength('123456789012').level).toBe('weak');
    expect(passwordStrength('abcdefghijkl').hint).toContain('sequences'); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
  });

  it('rates common passwords as weak even when long enough', () => {
    const result = passwordStrength('password1234');
    expect(result.level).toBe('weak');
    expect(result.hint).toContain('common');
    expect(passwordStrength('Qwerty123456!').level).toBe('weak');
  });

  it('penalises the username', () => {
    const plain = passwordStrength('operador1-Xk9#q'); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
    const personal = passwordStrength('operador1-Xk9#q', ['operador1']); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
    expect(personal.bits).toBeLessThan(plain.bits);
    expect(personal.hint).toContain('username');
  });

  it('ignores very short context words', () => {
    expect(passwordStrength('zq-Tm4#kLp!r', ['ab']).hint).not.toContain( // ggignore: Password-estimator fixture or dictionary entry, not a credential.
      'username',
    );
  });

  it('rates random 12 lowercase letters as fair', () => {
    expect(passwordStrength('kdjfmgzpqnwl').level).toBe('fair'); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
  });

  it('rates mixed-class 12 characters as good', () => {
    expect(passwordStrength('Tr0ub4dor&3x').level).toBe('good');
  });

  it('rates long passphrases as strong', () => {
    const phrase = passwordStrength('correct horse battery staple');
    expect(phrase.level).toBe('strong');
    expect(phrase.score).toBe(4);
    expect(phrase.tone).toBe('primary');
    expect(passwordStrength('blue radio tower sandwich').level).toBe('strong');
  });

  it('maps scores to tones', () => {
    expect(passwordStrength('aaaaaaaaaaaa').tone).toBe('error');
    expect(passwordStrength('kdjfmgzpqnwl').tone).toBe('warning'); // ggignore: Password-estimator fixture or dictionary entry, not a credential.
  });

  it('always offers a hint', () => {
    for (const value of [
      '',
      'aaaaaaaaaaaa',
      'kdjfmgzpqnwl', // ggignore: Password-estimator fixture or dictionary entry, not a credential.
      'Tr0ub4dor&3x',
      'correct horse battery staple',
    ])
      expect(passwordStrength(value).hint.length).toBeGreaterThan(0);
  });

  it('describes itself for assistive technology', () => {
    expect(passwordStrengthLabel(passwordStrength(''))).toMatch(
      /^Password strength: Too short\. Use at least 12/,
    );
  });
});

describe('helpers', () => {
  it('counts character classes', () => {
    expect(characterClasses('abc')).toBe(1);
    expect(characterClasses('aB3!')).toBe(4);
  });

  it('collapses runs and sequences', () => {
    expect(effectiveLength('aaaa')).toBe(1);
    expect(effectiveLength('aab')).toBe(3);
    expect(effectiveLength('abcx')).toBe(2);
    expect(effectiveLength('cba9')).toBe(2);
    expect(effectiveLength('qwertyZ')).toBe(2);
    expect(effectiveLength('k3m9')).toBe(4);
    // Direction never flips mid-sequence (p→q forward, then n backward).
    expect(effectiveLength('pqn')).toBe(3);
  });
});
