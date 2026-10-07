/**
 * Snapshot returned by the dispositions endpoint and the MCP tool: the booked
 * result of a fiscal period before year-end.
 */
export interface DispositionsProposal {
  entityType: 'aktiebolag' | 'enskild_firma' | 'handelsbolag' | 'kommanditbolag' | 'ekonomisk_forening'
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  /** Result before year-end, from the income statement (positive = profit). */
  netResultBefore: number
}
