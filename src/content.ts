export type TaskStatus = 'running' | 'waiting' | 'blocked' | 'done'
export type SurfaceView = 'feed' | 'board' | 'review' | 'artifacts'

export interface TaskItem {
  id: string
  title: string
  summary: string
  owner: string
  tenant: string
  status: TaskStatus
  progress: number
  hint: string
  tags: string[]
}

export interface SpaceItem {
  title: string
  subtitle: string
  count: number
}

export interface MetricItem {
  label: string
  value: string
  detail: string
}

export interface ArtifactItem {
  title: string
  kind: string
  detail: string
}

export const spaces: SpaceItem[] = [
  { title: 'Mission Feed', subtitle: 'Unified task stream', count: 12 },
  { title: 'Projects', subtitle: 'Workspace scoped', count: 5 },
  { title: 'Queues', subtitle: 'Background jobs', count: 7 },
  { title: 'Review', subtitle: 'Approvals & handoffs', count: 3 },
  { title: 'Artifacts', subtitle: 'Files, logs, diffs', count: 24 },
]

export const metrics: MetricItem[] = [
  { label: 'Running', value: '04', detail: 'Tasks in progress with live progress and log streaming.' },
  { label: 'Waiting', value: '02', detail: 'Needs input, approval, or a policy decision.' },
  { label: 'Done', value: '18', detail: 'Completed tasks with artifacts, summaries, and next actions.' },
]

export const tasks: TaskItem[] = [
  {
    id: 'finance-brief',
    title: 'Summarize the quarterly report and draft an executive memo',
    summary: 'The agent is extracting key signals, building a concise decision summary, and preparing a shareable artifact for review.',
    owner: 'pavi.sa_01',
    tenant: 'default',
    status: 'running',
    progress: 38,
    hint: 'Live progress + log streaming',
    tags: ['Strategy', 'Memo', 'Priority'],
  },
  {
    id: 'monitor-services',
    title: 'Monitor service health and notify on drift',
    summary: 'A background job is polling health signals and will escalate if thresholds are exceeded.',
    owner: 'ops-review',
    tenant: 'infra',
    status: 'waiting',
    progress: 12,
    hint: 'Waiting on schedule window',
    tags: ['Monitoring', 'Alert', 'Recurring'],
  },
  {
    id: 'deck-draft',
    title: 'Turn research notes into a lightweight deck',
    summary: 'Artifacts are being summarized into slides, speaker notes, and a previewable outline.',
    owner: 'researcher',
    tenant: 'product',
    status: 'done',
    progress: 100,
    hint: 'Artifact ready',
    tags: ['Slides', 'Research', 'Export'],
  },
  {
    id: 'policy-map',
    title: 'Map identity rules for a new workspace',
    summary: 'The control plane is validating owner, team, and callback policy before unlocking actions.',
    owner: 'security',
    tenant: 'shared',
    status: 'blocked',
    progress: 72,
    hint: 'Blocked by approval',
    tags: ['Policy', 'Identity', 'Sensitive'],
  },
]

export const artifacts: ArtifactItem[] = [
  {
    title: 'Executive memo draft',
    kind: 'Document preview',
    detail: 'Markdown + export-ready summary with links to raw supporting evidence.',
  },
  {
    title: 'Runtime log bundle',
    kind: 'Trace artifact',
    detail: 'Structured progress, step log, approvals, and retry reasons.',
  },
  {
    title: 'Policy envelope',
    kind: 'Control artifact',
    detail: 'Tenant, tool scope, callback target, and escalations for this task.',
  },
]

export const policyRows = [
  ['Actor', 'Master / pavi.sa_01'],
  ['Workspace', 'Agent Rider'],
  ['Permission level', 'Standard'],
  ['Sensitive actions', 'Require confirm'],
  ['Tool scope', 'Read · Write · Notify'],
  ['Callback target', 'WebUI + push inbox'],
] as const

export const liveTray = [
  { id: 'monitor-09', status: 'running' as TaskStatus, detail: 'Checks every 10m · last heartbeat 42s ago' },
  { id: 'memo-14', status: 'waiting' as TaskStatus, detail: 'Needs approval to write to shared space' },
  { id: 'deck-02', status: 'done' as TaskStatus, detail: 'Artifact ready · share link active' },
]
