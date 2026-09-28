/**
 * A JSON Schema validator for exactly the subset the public API's schemas use
 * (worker/lib/publicApi/schema.ts): type (one or a list), properties,
 * required, additionalProperties: false, items, enum, anyOf, $ref into
 * `#/components/schemas`, format uri / date-time, minimum.
 *
 * Small on purpose: the point is not to be a general validator but to fail
 * loudly on the two things that matter here — a field the schema does not
 * list (a leak, or undocumented drift) and a field the schema promises that
 * is missing or of the wrong type.
 */

type Schema = { [key: string]: unknown };

export interface SchemaError {
  path: string;
  message: string;
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return expected === 'number' && actual === 'integer';
}

export function validate(value: unknown, schema: Schema, components: Record<string, Schema>, path = '$'): SchemaError[] {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = components[name];
    if (!target) return [{ path, message: `unresolvable $ref ${schema.$ref}` }];
    return validate(value, target, components, path);
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Schema[]).map((s) => validate(value, s, components, path));
    if (branches.some((errors) => errors.length === 0)) return [];
    return [{ path, message: `matches no branch of anyOf: ${branches.map((e) => e[0]?.message).join(' | ')}` }];
  }
  const errors: SchemaError[] = [];
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeMatches(t, actual))) {
      return [{ path, message: `expected ${types.join('|')}, got ${actual}` }];
    }
  }
  if (actual === 'null') return errors;
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push({ path, message: `${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}` });
  }
  if (typeof value === 'string' && schema.format === 'uri' && !/^https?:\/\/[^\s]+$/.test(value)) {
    errors.push({ path, message: `${JSON.stringify(value)} is not an absolute http(s) URL` });
  }
  if (typeof value === 'string' && schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
    errors.push({ path, message: `${JSON.stringify(value)} is not a date-time` });
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push({ path, message: `${value} is below the minimum ${schema.minimum}` });
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) => errors.push(...validate(item, schema.items as Schema, components, `${path}[${i}]`)));
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: 'required property is missing' });
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) errors.push(...validate(v, props[key], components, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'property is not in the schema' });
    }
  }
  return errors;
}
