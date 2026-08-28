import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/lib/api';
import { classifyError } from '../src/components/ui/AsyncStates';

// The unified async-state system must NEVER conflate states:
// 401 is a sign-in prompt (not "no items"), 404 is not-found (not an error
// toast), 5xx/network are retryable errors (not "product not found").

test('401 classifies as unauthorized — never rendered as an empty list', () => {
  assert.equal(classifyError(new ApiError(401, 'Unauthorized')), 'unauthorized');
});

test('404 classifies as not-found', () => {
  assert.equal(classifyError(new ApiError(404, 'Not found')), 'not-found');
});

test('403 classifies as forbidden, distinct from unauthorized', () => {
  assert.equal(classifyError(new ApiError(403, 'Forbidden')), 'forbidden');
});

test('status 0 (fetch failure wrapped by the api client) is a network error', () => {
  assert.equal(classifyError(new ApiError(0, 'Network error')), 'network');
});

test('5xx classify as server errors (retryable), including 503 not-configured', () => {
  assert.equal(classifyError(new ApiError(500, 'Internal')), 'server');
  assert.equal(classifyError(new ApiError(502, 'Bad gateway')), 'server');
  assert.equal(classifyError(new ApiError(503, 'Not configured')), 'server');
});

test('other 4xx are generic errors that surface the server message', () => {
  assert.equal(classifyError(new ApiError(400, 'Invalid input')), 'error');
  assert.equal(classifyError(new ApiError(422, 'Unprocessable')), 'error');
  assert.equal(classifyError(new ApiError(429, 'Too many requests')), 'error');
});

test('raw fetch TypeErrors classify as network failures', () => {
  assert.equal(classifyError(new TypeError('Failed to fetch')), 'network');
});

test('unknown throwables fall back to a generic error, never a crash', () => {
  assert.equal(classifyError(new Error('boom')), 'error');
  assert.equal(classifyError('string throw'), 'error');
  assert.equal(classifyError(undefined), 'error');
  assert.equal(classifyError(null), 'error');
});
