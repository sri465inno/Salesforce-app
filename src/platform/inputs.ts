/** Intake: loads the recorded input fixtures and records their provenance (sha256 + recordedFrom). */
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, rel, ROOT } from '../shared/paths';
import { sha256 } from '../shared/hash';
import { InputDocument } from './types';
import { SourceReferences } from './source-refs';

export const INPUT_FILES: Record<string, string> = {
  initiative: 'initiative.json',
  epic: 'epic.json',
  story: 'story-001.json',
  'business-rules': 'business-rules.json',
  'graphql-contract': 'graphql-contract.json',
  'data-dictionary': 'data-dictionary.json',
  'source-code-references': 'source-code-references.json',
};
export const REQUIRED_INPUTS = ['story', 'business-rules', 'data-dictionary', 'graphql-contract'];

export interface FieldDef {
  type: 'string' | 'date' | 'datetime' | 'integer' | 'enum';
  source: string;
  required?: boolean;
  pattern?: string;
  enum?: string[];
  approvedValues?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  reference?: string;
  aliases?: string[];
  sensitivity?: string;
  syntheticDomain?: string;
  description: string;
}

export interface DataDictionary {
  version: string;
  entities: Record<string, { salesforceObject: string; fields: Record<string, FieldDef> }>;
  referenceData: {
    locations: { locationId: string; name: string; active: boolean }[];
    knownUnavailable: { locationId: string; resourceType: string; startDate: string; endDate: string; note: string }[];
    gatewayTokens: { declinedPrefix: string; pendingPrefix: string };
  };
}

export interface Story {
  id: string;
  epic: string;
  title: string;
  narrative: { asA: string; iWant: string; soThat: string };
  acceptanceCriteria: { id: string; text: string }[];
}
export interface Epic {
  id: string;
  title: string;
  acceptanceCriteria: { id: string; text: string }[];
  stories: { id: string; title: string; inScope: boolean }[];
}
export interface RuleCatalogue {
  version: string;
  rules: { id: string; text: string }[];
}

export interface Inputs {
  documents: InputDocument[];
  story: Story;
  epic: Epic | null;
  rules: RuleCatalogue;
  dictionary: DataDictionary;
  contract: { name: string; version: string; schemaFile: string; operations: string[]; schemaSha256: string };
  sourceRefs: SourceReferences | null;
}

export function loadInputs(selected: string[] = Object.keys(INPUT_FILES)): Inputs {
  const missing = REQUIRED_INPUTS.filter((k) => !selected.includes(k));
  if (missing.length) throw new Error(`Required inputs not selected: ${missing.join(', ')}`);
  const documents: InputDocument[] = [];
  for (const key of selected) {
    const name = INPUT_FILES[key];
    if (!name) throw new Error(`Unknown input: ${key}`);
    const file = path.join(FIXTURES_DIR, name);
    const text = fs.readFileSync(file, 'utf8');
    const content = JSON.parse(text) as { recordedFrom?: string };
    if (!content.recordedFrom) throw new Error(`Input ${key} has unknown provenance (no recordedFrom); rejected`);
    documents.push({ key, file: rel(ROOT, file), sha256: sha256(text), recordedFrom: content.recordedFrom, content });
  }
  const get = <T>(key: string) => (documents.find((d) => d.key === key)?.content ?? null) as T | null;
  const contract = get<Inputs['contract']>('graphql-contract')!;
  const schemaText = fs.readFileSync(path.join(ROOT, contract.schemaFile), 'utf8');
  documents.push({ key: 'graphql-schema', file: contract.schemaFile, sha256: sha256(schemaText), recordedFrom: 'Versioned contract file in this repository', content: null });
  return {
    documents,
    story: get<Story>('story')!,
    epic: get<Epic>('epic'),
    rules: get<RuleCatalogue>('business-rules')!,
    dictionary: get<DataDictionary>('data-dictionary')!,
    contract: { ...contract, schemaSha256: sha256(schemaText) },
    sourceRefs: get<SourceReferences>('source-code-references'),
  };
}

export function allFields(dictionary: DataDictionary): { entity: string; name: string; path: string; def: FieldDef }[] {
  return Object.entries(dictionary.entities).flatMap(([entity, e]) =>
    Object.entries(e.fields).map(([name, def]) => ({
      entity,
      name,
      path: entity === 'Customer' ? `customer.${name}` : entity === 'Payment' ? `payment.${name}` : name,
      def,
    })),
  );
}
