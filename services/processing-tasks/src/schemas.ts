import { z } from 'zod';
import { IdSchema } from '@signaldock/contracts';

export const TextEvidenceSchema = z
  .strictObject({
    communicationId: IdSchema,
    quote: z.string().min(1).max(1000),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine(
    (value) => value.end - value.start === value.quote.length,
    'Evidence span length does not match its quote.',
  );
export type TextEvidence = z.infer<typeof TextEvidenceSchema>;

export const CallsignFindingsSchema = z.strictObject({
  candidates: z
    .array(
      z.strictObject({
        value: z
          .string()
          .min(3)
          .max(20)
          .regex(/^[A-Z0-9]+(?:\/[A-Z0-9]+)?$/),
        mention: z.enum([
          'self_identification_candidate',
          'mentioned',
          'unknown',
        ]),
        evidence: z.array(TextEvidenceSchema).min(1).max(20),
      }),
    )
    .max(64),
});
export type CallsignFindings = z.infer<typeof CallsignFindingsSchema>;

export const EntityFindingsSchema = z.strictObject({
  entities: z
    .array(
      z.strictObject({
        kind: z.enum(['place', 'person', 'organization']),
        value: z.string().min(1).max(200),
        evidence: z.array(TextEvidenceSchema).min(1).max(20),
      }),
    )
    .max(64),
});
export type EntityFindings = z.infer<typeof EntityFindingsSchema>;

export const IncidentPrioritySchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
]);
export const EmergencyFindingsSchema = z
  .strictObject({
    detected: z.boolean(),
    priority: IncidentPrioritySchema,
    reasons: z
      .array(
        z.strictObject({
          ruleId: z.string().min(1).max(100).optional(),
          description: z.string().min(1).max(500),
          evidence: z.array(TextEvidenceSchema).min(1).max(20),
        }),
      )
      .max(100),
  })
  .refine(
    (value) => value.detected === value.reasons.length > 0,
    'Detection must be supported by reasons.',
  );
export type EmergencyFindings = z.infer<typeof EmergencyFindingsSchema>;

export const EmergencyRuleSchema = z
  .strictObject({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    enabled: z.boolean(),
    phrases: z.array(z.string().trim().min(2).max(100)).min(1).max(30),
    priority: IncidentPrioritySchema,
    radioIds: z.array(IdSchema).max(100).optional(),
    minHz: z.number().int().positive().optional(),
    maxHz: z.number().int().positive().optional(),
    activeFrom: z.iso.datetime().optional(),
    activeUntil: z.iso.datetime().optional(),
  })
  .refine(
    (rule) =>
      rule.minHz === undefined ||
      rule.maxHz === undefined ||
      rule.minHz <= rule.maxHz,
    'Frequency bounds are inverted.',
  )
  .refine(
    (rule) =>
      !rule.activeFrom ||
      !rule.activeUntil ||
      Date.parse(rule.activeFrom) < Date.parse(rule.activeUntil),
    'Time bounds are inverted.',
  );
export type EmergencyRule = z.infer<typeof EmergencyRuleSchema>;

export interface AnalysisScope {
  radioId?: string;
  frequencyHz?: number;
  capturedAt?: string;
}
