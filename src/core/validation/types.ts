export type ValidationLevel = 'ERROR' | 'WARNING' | 'INFO';

export interface ValidationIssue {
  level: ValidationLevel;
  path: string;
  message: string;
  line?: number;
  column?: number;
  /** Rule code for issues raised by tree governance hooks (fork). */
  code?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}