// Starter bundles for `od app init` (spec §11.1 + Appendix D).
//
// Both templates MUST stay valid and immediately compilable against the
// html-static target:
// - `crud` is the Appendix D project-console bundle, sourced from the
//   known-green `packages/application-ir/tests/fixtures/valid/project-console`
//   fixture (which fills in the boundary schemas the raw Appendix D example
//   leaves unresolved: `project-filter` / `project-page`), trimmed to a single
//   html-static projection target.
// - `marketing` mirrors the known-green `marketing-site` fixture (empty
//   domain/capabilities/boundary/persistence modules + a landing-page
//   frontend), also trimmed to a single html-static projection target.
//
// The fixtures are embedded as literals on purpose: cross-package reads of
// another package's `tests/` directory would break packaged builds and the
// app-package boundary rules. When the upstream fixtures change shape, re-sync
// them here (package tests keep the source of truth green).

export type StarterTemplateId = 'crud' | 'marketing';

export interface StarterFile {
  /** Project-relative path (POSIX separators) of the file to scaffold. */
  path: string;
  /** JSON-serializable document written with 2-space indentation. */
  content: unknown;
}

export interface StarterTemplate {
  id: StarterTemplateId;
  name: string;
  description: string;
  files: StarterFile[];
}

/** Single html-static projection shared by both starter templates. */
const PROJECTION_CONFIG_HTML_STATIC = {
  schemaVersion: 1,
  application: 'application.ir.json',
  targets: [
    {
      id: 'html-static',
      adapter: 'html-static',
      mode: 'scaffold',
      outputRoot: 'generated/html-static',
      frontend: { adapter: 'html-static' },
    },
  ],
};

// ---- crud (Appendix D project-console) -------------------------------------

const CRUD_BUNDLE = {
  schemaVersion: '1.0.0',
  applicationId: 'project-console',
  name: 'Project Console',
  modules: {
    domain: 'ir/domain.ir.json',
    capabilities: 'ir/capabilities.ir.json',
    boundary: 'ir/boundary.ir.json',
    persistence: 'ir/persistence.ir.json',
    frontend: 'ir/frontend.ir.json',
  },
  source: {
    projectId: 'project-console',
    runId: 'run-example',
    parentBundleHash: null,
  },
};

const CRUD_DOMAIN = {
  schemaVersion: '1.0.0',
  applicationId: 'project-console',
  entities: [
    {
      id: 'project',
      identity: 'project.id',
      fields: [
        { id: 'project.id', type: 'uuid', generated: true },
        { id: 'project.name', type: 'string', minLength: 1, maxLength: 120 },
        { id: 'project.status', type: 'project-status', default: 'active' },
        { id: 'project.version', type: 'integer', default: 1 },
      ],
      invariants: ['project.name-unique-within-owner', 'project.archived-is-readonly'],
    },
  ],
  enums: [{ id: 'project-status', values: ['active', 'archived'] }],
  valueObjects: [],
  scalarTypes: [],
  invariants: [
    {
      id: 'project.name-unique-within-owner',
      description: 'Project names are unique within one owner.',
    },
    {
      id: 'project.archived-is-readonly',
      description: 'Archived projects cannot be modified.',
    },
  ],
  stateMachines: [
    {
      id: 'project-lifecycle',
      states: ['active', 'archived'],
      transitions: [{ id: 'project.archive', from: ['active'], to: 'archived' }],
    },
  ],
};

const CRUD_CAPABILITIES = {
  schemaVersion: '1.0.0',
  applicationId: 'project-console',
  queries: [
    {
      id: 'projects.list',
      input: 'project-filter',
      output: 'project-page',
      authorization: 'project.read',
      errors: ['UNAUTHORIZED', 'SERVICE_UNAVAILABLE'],
    },
  ],
  commands: [
    {
      id: 'projects.create',
      input: 'create-project-input',
      output: 'project',
      transactional: true,
      idempotency: 'required',
      authorization: 'project.create',
      preconditions: [],
      effects: [
        { kind: 'create', entity: 'project' },
        { kind: 'emit', event: 'project-created' },
      ],
      errors: ['PROJECT_NAME_CONFLICT', 'UNAUTHORIZED', 'VALIDATION_FAILED'],
    },
  ],
  events: [
    {
      id: 'project-created',
      payload: 'project',
      ordering: 'per-aggregate',
      replay: 'not-required',
      criticality: 'advisory',
    },
  ],
  workflows: [],
  authorizationCapabilities: ['project.read', 'project.create'],
  errorCatalog: [
    { id: 'PROJECT_NAME_CONFLICT', recoverable: true },
    { id: 'UNAUTHORIZED', recoverable: true },
    { id: 'VALIDATION_FAILED', recoverable: true },
    { id: 'SERVICE_UNAVAILABLE', recoverable: true },
  ],
};

const CRUD_BOUNDARY = {
  schemaVersion: '1.0.0',
  applicationId: 'project-console',
  operations: [
    {
      id: 'projects.list',
      capability: 'projects.list',
      input: 'project-filter',
      output: 'project-page',
      errors: ['UNAUTHORIZED', 'SERVICE_UNAVAILABLE'],
    },
    {
      id: 'projects.create',
      capability: 'projects.create',
      input: 'create-project-input',
      output: 'project',
      errors: ['PROJECT_NAME_CONFLICT', 'UNAUTHORIZED', 'VALIDATION_FAILED'],
      idempotencyKey: 'required',
    },
  ],
  schemas: [
    {
      id: 'create-project-input',
      kind: 'object',
      fields: [{ id: 'name', type: 'string', required: true }],
    },
    {
      id: 'project-filter',
      kind: 'object',
      fields: [{ id: 'status', type: 'string', required: false }],
    },
    {
      id: 'project-page',
      kind: 'object',
      fields: [
        { id: 'items', type: 'array', required: true },
        { id: 'total', type: 'integer', required: true },
      ],
    },
  ],
  errors: [
    {
      id: 'PROJECT_NAME_CONFLICT',
      presentationHint: 'field',
      field: 'name',
    },
  ],
  subscriptions: [],
  versioningPolicy: 'compatible-additive',
};

const CRUD_PERSISTENCE = {
  schemaVersion: '1.0.0',
  applicationId: 'project-console',
  aggregates: [
    {
      id: 'project',
      rootEntity: 'project',
      transactionBoundary: true,
    },
  ],
  repositories: [
    {
      id: 'project-repository',
      aggregate: 'project',
      operations: ['get', 'list', 'insert', 'update'],
    },
  ],
  relations: [],
  indexes: [
    {
      id: 'project-owner-status',
      entity: 'project',
      fields: ['ownerId', 'status'],
      unique: false,
    },
  ],
  uniqueness: [
    {
      id: 'project-name-per-owner',
      entity: 'project',
      fields: ['ownerId', 'name'],
    },
  ],
  retention: [],
  deletionPolicies: [
    {
      entity: 'project',
      mode: 'soft',
    },
  ],
  concurrency: [
    {
      aggregate: 'project',
      strategy: 'optimistic',
      versionField: 'version',
    },
  ],
  migrationIntent: [],
};

const CRUD_FRONTEND = {
  schemaVersion: '1.0.0',
  applicationId: 'project-console',
  routes: [
    {
      id: 'route.projects',
      path: '/projects',
      screen: 'screen.projects',
    },
  ],
  screens: [
    {
      id: 'screen.projects',
      rootNode: 'semantic.projects-dashboard',
    },
  ],
  components: [],
  nodes: [
    {
      id: 'semantic.projects-dashboard',
      level: 'semantic',
      kind: 'dashboard',
      slots: {
        content: ['component.project-list', 'component.create-project-form'],
      },
      bindings: [],
      actions: [],
      states: ['loading', 'empty', 'ready', 'error'],
      styleIntent: {
        density: 'comfortable',
        width: 'wide',
      },
      responsive: {
        phone: 'stack',
        desktop: 'grid',
      },
      accessibility: {
        landmark: 'main',
        headingLevel: 1,
      },
      sourceRef: 'brief.projects-dashboard',
    },
    {
      id: 'component.project-list',
      level: 'component',
      kind: 'list',
      slots: {},
      bindings: [],
      actions: [],
      states: ['loading', 'empty', 'ready', 'error'],
      styleIntent: {},
      responsive: {},
      accessibility: {},
      sourceRef: 'brief.project-list',
    },
    {
      id: 'component.create-project-form',
      level: 'component',
      kind: 'form',
      slots: {
        fields: ['atomic.project-name'],
        actions: ['atomic.create-project'],
      },
      bindings: [],
      actions: [
        {
          trigger: 'submit',
          operation: 'projects.create',
          input: {
            name: 'atomic.project-name.value',
          },
        },
      ],
      states: ['idle', 'submitting', 'success', 'validation-error', 'service-error'],
      styleIntent: {
        surface: 'raised',
      },
      responsive: {},
      accessibility: {
        label: 'Create project',
      },
      sourceRef: 'brief.create-project',
    },
    {
      id: 'atomic.project-name',
      level: 'atomic',
      kind: 'input',
      children: [],
      bindings: [],
      actions: [],
      states: ['empty', 'valid', 'invalid'],
      styleIntent: {
        size: 'medium',
      },
      responsive: {},
      accessibility: {
        label: 'Project name',
        required: true,
      },
      sourceRef: 'domain.project.name',
    },
    {
      id: 'atomic.create-project',
      level: 'atomic',
      kind: 'button',
      children: [],
      bindings: [],
      actions: [
        {
          trigger: 'activate',
          intent: 'submit-nearest-form',
        },
      ],
      states: ['enabled', 'disabled', 'pending'],
      styleIntent: {
        variant: 'primary',
      },
      responsive: {},
      accessibility: {
        label: 'Create project',
      },
      sourceRef: 'capability.projects.create',
    },
  ],
  flows: [],
  localState: [],
  operationBindings: [
    {
      node: 'component.create-project-form',
      operation: 'projects.create',
    },
  ],
  tokenReferences: ['--bg', '--surface', '--fg', '--muted', '--border', '--accent'],
  accessibilityDefaults: {
    focusVisible: true,
    reducedMotion: true,
  },
};

// ---- marketing (marketing-site) ---------------------------------------------

const MARKETING_APPLICATION_ID = 'marketing-site';

const MARKETING_BUNDLE = {
  schemaVersion: '1.0.0',
  applicationId: MARKETING_APPLICATION_ID,
  name: 'Marketing Site',
  modules: {
    domain: 'ir/domain.ir.json',
    capabilities: 'ir/capabilities.ir.json',
    boundary: 'ir/boundary.ir.json',
    persistence: 'ir/persistence.ir.json',
    frontend: 'ir/frontend.ir.json',
  },
  source: {
    projectId: MARKETING_APPLICATION_ID,
    runId: 'run-example',
    parentBundleHash: null,
  },
};

const MARKETING_FRONTEND = {
  schemaVersion: '1.0.0',
  applicationId: MARKETING_APPLICATION_ID,
  routes: [
    {
      id: 'route.home',
      path: '/',
      screen: 'screen.home',
    },
  ],
  screens: [
    {
      id: 'screen.home',
      rootNode: 'semantic.landing-page',
    },
  ],
  components: [],
  nodes: [
    {
      id: 'semantic.landing-page',
      level: 'semantic',
      kind: 'landing',
      slots: {
        content: ['component.hero-banner', 'component.cta-section'],
      },
      bindings: [],
      actions: [],
      states: [],
      styleIntent: {},
      responsive: {},
      accessibility: {},
      sourceRef: 'brief.landing-page',
    },
    {
      id: 'component.hero-banner',
      level: 'component',
      kind: 'hero',
      slots: {},
      bindings: [],
      actions: [],
      states: [],
      styleIntent: {},
      responsive: {},
      accessibility: {},
      sourceRef: 'brief.hero-banner',
    },
    {
      id: 'component.cta-section',
      level: 'component',
      kind: 'cta',
      slots: {},
      bindings: [],
      actions: [],
      states: [],
      styleIntent: {},
      responsive: {},
      accessibility: {},
      sourceRef: 'brief.cta',
    },
  ],
  flows: [],
  localState: [],
  operationBindings: [],
  tokenReferences: ['--bg', '--surface', '--fg'],
  accessibilityDefaults: {
    focusVisible: true,
    reducedMotion: true,
  },
};

/** Shared empty-module shape for the marketing template (no domain model). */
function emptyModule(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    applicationId: MARKETING_APPLICATION_ID,
    ...extra,
  };
}

const MARKETING_DOMAIN = emptyModule({
  entities: [],
  enums: [],
  valueObjects: [],
  scalarTypes: [],
  invariants: [],
  stateMachines: [],
});

const MARKETING_CAPABILITIES = emptyModule({
  queries: [],
  commands: [],
  events: [],
  workflows: [],
  authorizationCapabilities: [],
  errorCatalog: [],
});

const MARKETING_BOUNDARY = emptyModule({
  operations: [],
  schemas: [],
  errors: [],
  subscriptions: [],
  versioningPolicy: 'compatible-additive',
});

const MARKETING_PERSISTENCE = emptyModule({
  aggregates: [],
  repositories: [],
  relations: [],
  indexes: [],
  uniqueness: [],
  retention: [],
  deletionPolicies: [],
  concurrency: [],
  migrationIntent: [],
});

// ---- registry ---------------------------------------------------------------

export const STARTER_TEMPLATES: Record<StarterTemplateId, StarterTemplate> = {
  crud: {
    id: 'crud',
    name: 'Project Console',
    description: 'Appendix D project-console bundle: one entity, one command, one screen.',
    files: [
      { path: 'application.ir.json', content: CRUD_BUNDLE },
      { path: 'ir/domain.ir.json', content: CRUD_DOMAIN },
      { path: 'ir/capabilities.ir.json', content: CRUD_CAPABILITIES },
      { path: 'ir/boundary.ir.json', content: CRUD_BOUNDARY },
      { path: 'ir/persistence.ir.json', content: CRUD_PERSISTENCE },
      { path: 'ir/frontend.ir.json', content: CRUD_FRONTEND },
      { path: 'projection.config.json', content: PROJECTION_CONFIG_HTML_STATIC },
    ],
  },
  marketing: {
    id: 'marketing',
    name: 'Marketing Site',
    description: 'Landing-page bundle: no domain model, one route, hero + CTA.',
    files: [
      { path: 'application.ir.json', content: MARKETING_BUNDLE },
      { path: 'ir/domain.ir.json', content: MARKETING_DOMAIN },
      { path: 'ir/capabilities.ir.json', content: MARKETING_CAPABILITIES },
      { path: 'ir/boundary.ir.json', content: MARKETING_BOUNDARY },
      { path: 'ir/persistence.ir.json', content: MARKETING_PERSISTENCE },
      { path: 'ir/frontend.ir.json', content: MARKETING_FRONTEND },
      { path: 'projection.config.json', content: PROJECTION_CONFIG_HTML_STATIC },
    ],
  },
};

export function isStarterTemplateId(value: string): value is StarterTemplateId {
  return value === 'crud' || value === 'marketing';
}
