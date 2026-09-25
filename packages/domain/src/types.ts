import type { z } from 'zod';
import {
  BrokerSchema,
  CriticalFactSchema,
  CustomerSchema,
  DateFactSchema,
  DocumentSchema,
  DocumentSiteAssociationSchema,
  DuplicateSignalsSchema,
  EvidenceRefSchema,
  ProcessingStatusSchema,
  ReadinessInputSchema,
  ReadinessResultSchema,
  RuleIdSchema,
  RuleResultSchema,
  SiteSchema,
  TenderRouteSchema,
  TenderSchema,
  MeterSiteAssociationSchema,
  ProcessingRecordSchema,
} from './schemas.js';

export type TenderRoute = z.infer<typeof TenderRouteSchema>;
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>;
export type ProcessingRecord = z.infer<typeof ProcessingRecordSchema>;
export type Customer = z.infer<typeof CustomerSchema>;
export type Broker = z.infer<typeof BrokerSchema>;
export type Site = z.infer<typeof SiteSchema>;
export type TenderDocument = z.infer<typeof DocumentSchema>;
export type Tender = z.infer<typeof TenderSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type DateFact = z.infer<typeof DateFactSchema>;
export type DocumentSiteAssociation = z.infer<typeof DocumentSiteAssociationSchema>;
export type MeterSiteAssociation = z.infer<typeof MeterSiteAssociationSchema>;
export type CriticalFact = z.infer<typeof CriticalFactSchema>;
export type DuplicateSignals = z.infer<typeof DuplicateSignalsSchema>;
export type ReadinessInput = z.infer<typeof ReadinessInputSchema>;
export type RuleId = z.infer<typeof RuleIdSchema>;
export type RuleResult = z.infer<typeof RuleResultSchema>;
export type ReadinessResult = z.infer<typeof ReadinessResultSchema>;

export type Rule = (input: ReadinessInput) => RuleResult;
