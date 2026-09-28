/**
 * THE PUBLIC API'S SCHEMA VOCABULARY — one small set of builders for JSON
 * Schema (the 2020-12 dialect OpenAPI 3.1 uses).
 *
 * The same objects serve twice:
 *   - as `components.schemas` in `/api/public/v1/openapi.json`, so an AI agent
 *     reads exactly what each field is;
 *   - as the ALLOWLIST the tests hold every live response to: every object is
 *     `additionalProperties: false` and every property is `required`, so a
 *     field that is not written here cannot reach a response without a test
 *     failing (tests/publicApi.test.ts).
 *
 * Every property is present in every response — `null` when there is no
 * value — so a client never has to tell "absent" from "empty".
 */

export type JsonSchema = { [key: string]: unknown };

const described = (schema: JsonSchema, description?: string): JsonSchema =>
  description ? { ...schema, description } : schema;

export const string = (description?: string, extra: JsonSchema = {}): JsonSchema =>
  described({ type: 'string', ...extra }, description);

export const url = (description?: string): JsonSchema => string(description, { format: 'uri' });

export const dateTime = (description?: string): JsonSchema => string(description, { format: 'date-time' });

export const integer = (description?: string, extra: JsonSchema = {}): JsonSchema =>
  described({ type: 'integer', ...extra }, description);

export const number = (description?: string, extra: JsonSchema = {}): JsonSchema =>
  described({ type: 'number', ...extra }, description);

export const boolean = (description?: string): JsonSchema => described({ type: 'boolean' }, description);

export const enumOf = (values: readonly string[], description?: string): JsonSchema =>
  described({ type: 'string', enum: [...values] }, description);

export const array = (items: JsonSchema, description?: string): JsonSchema =>
  described({ type: 'array', items }, description);

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** A value or `null`. */
export function nullable(schema: JsonSchema): JsonSchema {
  if (typeof schema.type === 'string') {
    const { description, ...rest } = schema;
    return described({ ...rest, type: [schema.type, 'null'] }, description as string | undefined);
  }
  return { anyOf: [schema, { type: 'null' }] };
}

/** A closed object: every property required, nothing else allowed. */
export function object(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return described(
    { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    description
  );
}

/** The same text in the site's three languages — '' where one was never written. */
export const localized = (description?: string): JsonSchema =>
  object(
    {
      ar: string('Arabic (the site\'s source language).'),
      en: string('English.'),
      ckb: string('Central Kurdish (Sorani).'),
    },
    description
  );
