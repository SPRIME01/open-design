export interface GeneratedFileManifestEntry {
  hash: string;
  sourceIds: string[];
}

export interface GeneratedFileManifest {
  schemaVersion: number;
  targetId: string;
  applicationId: string;
  compilerVersion: string;
  sourceHash: string;
  configHash: string;
  adapterVersions: {
    frontend: string;
    transport?: string;
    persistence?: string;
  };
  files: Record<string, GeneratedFileManifestEntry>;
}
