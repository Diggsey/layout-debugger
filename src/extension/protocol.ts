/** Serialized version of TraceStep — Element refs replaced with path + descriptor. */
export interface SerializedStep {
  elementPath: string;
  elementDesc: string;
  summary: string;
  details: Record<string, string>;
  substeps?: SerializedStep[];
}

/** Serialized analysis result that can cross context boundaries. */
export interface SerializedResult {
  elementPath: string;
  elementDesc: string;
  borderBoxWidth: number;
  borderBoxHeight: number;
  steps: SerializedStep[];
}
