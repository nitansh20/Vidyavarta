import { z } from 'zod';
import type { Audience, Student } from './types';
export const audienceSchema = z.object({ branch: z.enum(['CSE','IT','ALL']), year: z.number().int().min(1).max(4).nullable(), sections: z.array(z.enum(['A','B'])).min(1).max(2) }).strict();
export const studentSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(120), email: z.email(), college: z.string().min(1).max(120), branch: z.enum(['CSE','IT']), year: z.number().int().min(1).max(4), section: z.enum(['A','B']) }).strict();
export function resolveAudience(students: Student[], input: Audience) {
  const a = audienceSchema.parse(input);
  return students.filter(s => (a.branch === 'ALL' || s.branch === a.branch) && (!a.year || a.year === s.year) && a.sections.includes(s.section));
}
/** Deliberately a small grammar, never eval. Structured selectors are preferred. */
export function parseSelector(input: string): Audience {
  const match = /^(cse|it|all)(?:\.year\s*==\s*([1-4]))?(?:\s*&&\s*section\s+in\s*\[\s*([AB](?:\s*,\s*[AB])?)\s*\])?$/i.exec(input.trim());
  if (!match) throw new Error('Use cse.year==3 && section in [A,B], or a structured audience.');
  return { branch: match[1].toUpperCase() as Audience['branch'], year: match[2] ? Number(match[2]) : null, sections: match[3] ? match[3].toUpperCase().split(',').map(s => s.trim()) : ['A','B'] };
}
