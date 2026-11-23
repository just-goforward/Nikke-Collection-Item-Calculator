// These enums, not arbitrary runtime error strings, form the diagnostic vocabulary.
export const incidentPath = '/api/recalculation-incident';
export const incidentOrigin = 'https://nikkecollection.com';
export const reasons = ['source','capacity','binding','worker','other'] as const;
export const stages = ['manual','outcome','conversion'] as const;
export type IncidentReason = typeof reasons[number];
export type IncidentStage = typeof stages[number];
