// js-yaml 4 本身沒有附型別;只宣告流程定義用得到的部分,不另外加 @types/js-yaml。
declare module 'js-yaml' {
  export interface YamlSchema { readonly __schema: unique symbol }
  export const JSON_SCHEMA: YamlSchema;
  export const CORE_SCHEMA: YamlSchema;
  export const FAILSAFE_SCHEMA: YamlSchema;
  export interface LoadOptions { filename?: string; schema?: YamlSchema; json?: boolean }
  export interface DumpOptions { schema?: YamlSchema; indent?: number; lineWidth?: number; noRefs?: boolean; sortKeys?: boolean; quotingType?: "'" | '"'; forceQuotes?: boolean }
  export function load(text: string, options?: LoadOptions): unknown;
  export function dump(value: unknown, options?: DumpOptions): string;
  export class YAMLException extends Error { reason: string; mark?: { line: number; column: number } }
}
