// Chat types for AI chatbot

export interface ChatMessage {
  id: string
  session_id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  sources: SourceReference[]
  artifact?: ArtifactSpec | null
  created_at: string
}

export interface ChatSession {
  id: string
  user_id: string
  title: string | null
  created_at: string
}

export interface SourceReference {
  id: string
  source_file: string
  title: string
  section_title: string | null
  similarity: number
}

export interface KnowledgeDocument {
  id: string
  source_file: string
  title: string
  section_title: string | null
  content: string
  content_hash: string
  embedding: number[] | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface ChatRequest {
  message: string
  session_id?: string
}

export interface ChatResponse {
  message: ChatMessage
  session_id: string
}

export interface StreamChunk {
  type: 'content' | 'sources' | 'done' | 'error' | 'tool_start' | 'artifact'
  content?: string
  sources?: SourceReference[]
  error?: string
  toolName?: string
  artifact?: ArtifactSpec
}

// ── Artifact Types ──────────────────────────────────────────────

export type ArtifactSpec =
  | ChartArtifact
  | TableArtifact
  | KpiCardsArtifact
  | AgingBucketsArtifact

export interface ChartArtifact {
  type: 'bar_chart' | 'line_chart' | 'pie_chart' | 'stacked_bar'
  title: string
  data: { label: string; value: number; color?: string }[]
  unit?: string
  subtitle?: string
}

export interface TableArtifact {
  type: 'table'
  title: string
  columns: { key: string; label: string; align?: 'left' | 'right' }[]
  rows: Record<string, string | number>[]
  summary_row?: Record<string, string | number>
}

export interface KpiCardsArtifact {
  type: 'kpi_cards'
  title?: string
  cards: { label: string; value: string; trend?: 'up' | 'down' | 'flat'; change?: string }[]
}

export interface AgingBucketsArtifact {
  type: 'aging_buckets'
  title: string
  buckets: { label: string; amount: number; count: number }[]
  total: number
}
