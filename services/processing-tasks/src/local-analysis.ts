import {
  type AnalysisScope,
  type CallsignFindings,
  type EmergencyFindings,
  EmergencyRuleSchema,
  type EmergencyRule,
  type EntityFindings,
  type TextEvidence,
} from './schemas.js';

function evidence(
  text: string,
  communicationId: string,
  start: number,
  end: number,
): TextEvidence {
  return { communicationId, quote: text.slice(start, end), start, end };
}

/** Finds textual candidates; no result authenticates or identifies the speaker. */
export function extractCallsigns(
  text: string,
  communicationId: string,
): CallsignFindings {
  const pattern =
    /(?<![\p{L}\p{N}])(?:[A-Z]{1,2}\d[A-Z0-9]{1,4}|\d[A-Z]\d[A-Z0-9]{1,4})(?:\/(?:P|M|MM|AM|QRP|\d))?(?![\p{L}\p{N}])/giu;
  const candidates: CallsignFindings['candidates'] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const value = match[0].toUpperCase();
    if (seen.has(value)) continue;
    seen.add(value);
    const before = text.slice(Math.max(0, match.index - 45), match.index);
    const mention =
      /(?:\bthis is|\bmy callsign is|\bsoy|\bmi indicativo es)\s*$/i.test(
        before,
      )
        ? 'self_identification_candidate'
        : /(?:\btell|\bcontact|\bfor|\bpara|\bllama a)\s*$/i.test(before)
          ? 'mentioned'
          : 'unknown';
    candidates.push({
      value,
      mention,
      evidence: [
        evidence(
          text,
          communicationId,
          match.index,
          match.index + match[0].length,
        ),
      ],
    });
    if (candidates.length === 64) break;
  }
  return { candidates };
}

/** Conservative place mentions only; extracted names are not confirmed positions. */
export function extractEntities(
  text: string,
  communicationId: string,
): EntityFindings {
  const pattern =
    /(?:\bat |\bnear |\bin |\ben |\bcerca de |\bsector )([\p{Lu}][\p{L}\p{N}'’.-]*(?:\s+[\p{Lu}][\p{L}\p{N}'’.-]*){0,4})/gu;
  const entities: EntityFindings['entities'] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1]!.replace(/[.]+$/u, '');
    const start = match.index + match[0].indexOf(value);
    if (entities.some((item) => item.value === value)) continue;
    entities.push({
      kind: 'place',
      value,
      evidence: [evidence(text, communicationId, start, start + value.length)],
    });
    if (entities.length === 64) break;
  }
  return { entities };
}

export const defaultEmergencyRules: readonly EmergencyRule[] = [
  {
    id: 'default.distress',
    name: 'Distress expressions',
    enabled: true,
    phrases: [
      'mayday',
      'sos',
      'auxilio',
      'emergencia',
      'emergency',
      'necesito ayuda',
      'need help',
    ],
    priority: 'high',
  },
];
const priorityRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const escapePattern = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

export function ruleMatchesScope(
  rule: EmergencyRule,
  scope: AnalysisScope,
): boolean {
  if (!rule.enabled) return false;
  if (
    rule.radioIds?.length &&
    (!scope.radioId || !rule.radioIds.includes(scope.radioId))
  )
    return false;
  if (
    (rule.minHz !== undefined || rule.maxHz !== undefined) &&
    scope.frequencyHz === undefined
  )
    return false;
  if (rule.minHz !== undefined && scope.frequencyHz! < rule.minHz) return false;
  if (rule.maxHz !== undefined && scope.frequencyHz! > rule.maxHz) return false;
  if ((rule.activeFrom || rule.activeUntil) && !scope.capturedAt) return false;
  if (scope.capturedAt && !Number.isFinite(Date.parse(scope.capturedAt)))
    return false;
  if (
    rule.activeFrom &&
    Date.parse(scope.capturedAt!) < Date.parse(rule.activeFrom)
  )
    return false;
  if (
    rule.activeUntil &&
    Date.parse(scope.capturedAt!) > Date.parse(rule.activeUntil)
  )
    return false;
  return true;
}

/** Literal phrase rules avoid evaluating administrator-supplied regular expressions. */
export function detectEmergency(
  text: string,
  communicationId: string,
  rules: readonly EmergencyRule[] = defaultEmergencyRules,
  scope: AnalysisScope = {},
): EmergencyFindings {
  const reasons: EmergencyFindings['reasons'] = [];
  let priority: EmergencyFindings['priority'] = 'low';
  if (rules.length > 100)
    throw new Error('At most 100 emergency rules may be evaluated at once.');
  for (const input of rules) {
    const rule = EmergencyRuleSchema.parse(input);
    if (!ruleMatchesScope(rule, scope)) continue;
    const matches: TextEvidence[] = [];
    for (const phrase of rule.phrases) {
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapePattern(phrase)}(?![\\p{L}\\p{N}])`,
        'giu',
      );
      for (const match of text.matchAll(pattern)) {
        const before = text.slice(Math.max(0, match.index - 24), match.index);
        if (/\b(?:no|not|without|sin|ninguna?)\s+(?:an?\s+)?$/iu.test(before))
          continue;
        matches.push(
          evidence(
            text,
            communicationId,
            match.index,
            match.index + match[0].length,
          ),
        );
        if (matches.length === 20) break;
      }
      if (matches.length === 20) break;
    }
    if (matches.length) {
      reasons.push({
        ruleId: rule.id,
        description: rule.name,
        evidence: matches,
      });
      if (priorityRank[rule.priority] > priorityRank[priority])
        priority = rule.priority;
    }
  }
  return { detected: reasons.length > 0, priority, reasons };
}

export function summarizeExtractively(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]?(?:\s+|$)/gu) ?? [text];
  return sentences.slice(0, 3).join('').trim().slice(0, 1500);
}
