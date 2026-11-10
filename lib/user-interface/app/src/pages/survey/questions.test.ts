/**
 * The app's questions and the server's schema are one contract. If they
 * drift, a parent's answer is refused by the server with nothing on screen to
 * say why. This reads the deployed schema file itself, not a copy.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { QUESTIONS, SCALE, anyDisagree, pruneBaseline, pruneHousehold } from './questions';

const SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../chatbot-api/functions/user-profile-handler/survey_schema.json',
);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('the survey questions match the server schema', () => {
  test('the agreement scale is the same', () => {
    expect([...SCALE]).toEqual(schema.scale);
  });

  test.each(['before', 'after', 'household'] as const)('the %s phase is the same', (phase) => {
    const server = schema.phases[phase];
    const app = plain(QUESTIONS[phase]);
    expect(app.parts).toEqual(server.parts);
    expect(app.statuses).toEqual(server.statuses);
    expect(app.choice).toEqual(server.choice);
    expect(app.multi).toEqual(server.multi);
    expect(app.text).toEqual(server.text);
    expect(app.email ?? []).toEqual(server.email ?? []);
  });
});

describe('follow-up boxes', () => {
  test('appear only for a disagreement', () => {
    expect(anyDisagree({ p1: 'agree', p2: 'unsure' }, ['p1', 'p2'])).toBe(false);
    expect(anyDisagree({ p1: 'agree', p2: 'somewhat_disagree' }, ['p1', 'p2'])).toBe(true);
  });

  test('a box whose question no longer applies is not saved', () => {
    const answers = { p1: 'agree', speakWhy: 'typed earlier', r1: 'agree', reflectParts: ['other'], reflectOther: 'x' };
    expect(pruneBaseline(answers)).toEqual({ p1: 'agree', r1: 'agree' });
    expect(pruneBaseline({ r1: 'disagree', reflectParts: ['goals'], reflectOther: 'x' }))
      .toEqual({ r1: 'disagree', reflectParts: ['goals'] });
    expect(pruneHousehold({ stayInTouch: 'no', email: 'a@b.org' })).toEqual({ stayInTouch: 'no' });
  });
});
