import {rootCandidate} from './rootCandidate';

// Shared by the eager reload writer and lazy restore parser, without loading either from the other.
export const legacyRecoveryKey = rootCandidate ? 'nikke:legacy-reload-input:v1' : 'preview:nikke:legacy-reload-input:v1';
