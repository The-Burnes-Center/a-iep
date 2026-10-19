/**
 * What every alarm says, in both stacks.
 *
 * An alert is read at 2am by someone who did not build the thing, so its
 * wording is a property worth pinning, not a matter of taste. These tests
 * read the descriptions out of the SYNTHESIZED templates, which is what
 * CloudWatch will actually carry into Slack, and check the contract the alert
 * formatter lambda depends on:
 *
 *   [PROD] [CRITICAL] <symptom>
 *   Impact: ...
 *   Fires when: ...
 *   Check first:
 *   1. ...
 *   Runbook: <url>
 *   Recovery: ...
 *
 * The same descriptions are written to test/fixtures/alarm-descriptions.json,
 * and test/python/test_alert_formatter.py runs every one of them through the
 * real formatter. That fixture is the bridge between the two languages: a
 * reworded description that the formatter can no longer parse fails there.
 * Regenerate it with `UPDATE_ALARM_FIXTURE=1 npm test -- alert-copy`.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'alarm-descriptions.json');
const RUNBOOK = path.join(__dirname, '..', '..', 'docs', 'RUNBOOK.md');

type Environment = 'staging' | 'production';
type AlarmRow = { AlarmName: string; AlarmDescription: unknown };

function synth(environment: Environment): Template {
  const saved = process.env.ENVIRONMENT;
  process.env.ENVIRONMENT = environment;
  process.env.JSII_DEPRECATED = 'quiet';
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { GenAiMvpStack } = require('../../lib/gen-ai-mvp-stack');
    const { stackName } = require('../../lib/constants');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    return Template.fromStack(new GenAiMvpStack(app, stackName, {}));
  } finally {
    process.env.ENVIRONMENT = saved;
  }
}

function alarmsOf(template: Template): Record<string, any>[] {
  return Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
    (r: any) => r.Properties,
  );
}

/** GitHub's heading slugs: lowercase, punctuation dropped, spaces to hyphens. */
function runbookAnchors(): Set<string> {
  const anchors = new Set<string>();
  for (const line of fs.readFileSync(RUNBOOK, 'utf8').split('\n')) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      anchors.add(match[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
    }
  }
  return anchors;
}

const TITLE = /^\[(PROD|STAGING)\] \[(CRITICAL|WARNING|INFO)\] (\S.*)$/;

const rowsByEnvironment: Record<Environment, AlarmRow[]> = { staging: [], production: [] };

describe.each([
  ['staging', 'STAGING'],
  ['production', 'PROD'],
] as [Environment, string][])('alarm wording (%s)', (environment, label) => {
  let alarms: Record<string, any>[];

  beforeAll(() => {
    alarms = alarmsOf(synth(environment));
    rowsByEnvironment[environment] = alarms
      .map((a) => ({ AlarmName: a.AlarmName, AlarmDescription: a.AlarmDescription }))
      .sort((a, b) => a.AlarmName.localeCompare(b.AlarmName));
  }, 180_000);

  const descriptions = (): { name: string; text: string }[] =>
    alarms.map((a) => ({ name: a.AlarmName, text: a.AlarmDescription }));

  test('there are alarms to check', () => {
    // A synth that quietly produced none would pass every test below.
    expect(alarms.length).toBeGreaterThan(80);
  });

  test('every description is a plain string that CloudFormation will accept', () => {
    for (const { name, text } of descriptions()) {
      // An object here means a token ({"Ref": ...}) leaked into the words.
      expect(typeof text).toBe('string');
      // CloudFormation caps AlarmDescription at 1024 characters.
      expect(text.length).toBeLessThanOrEqual(1024);
      expect(name).toBeTruthy();
    }
  });

  test('every description starts with the environment and the severity, as words', () => {
    for (const { name, text } of descriptions()) {
      const first = text.split('\n')[0];
      const match = TITLE.exec(first);
      expect({ name, first, matched: match !== null }).toEqual({ name, first, matched: true });
      expect(match![1]).toBe(label);
    }
  });

  test('every description names the symptom, the people affected and the threshold', () => {
    for (const { name, text } of descriptions()) {
      const lines = text.split('\n');
      const symptom = TITLE.exec(lines[0])![3];
      // A headline, not a sentence of metric jargon: starts with a capital,
      // no trailing full stop, long enough to say something.
      expect({ name, ok: /^[A-Z"]/.test(symptom) && !symptom.endsWith('.') && symptom.length >= 10 })
        .toEqual({ name, ok: true });
      expect({ name, impact: lines.some((l) => l.startsWith('Impact: ') && l.length > 20) })
        .toEqual({ name, impact: true });
      expect({ name, fires: lines.some((l) => l.startsWith('Fires when: ') && l.endsWith('.')) })
        .toEqual({ name, fires: true });
    }
  });

  test('every description gives one or two concrete first steps', () => {
    for (const { name, text } of descriptions()) {
      const lines = text.split('\n');
      const at = lines.indexOf('Check first:');
      expect({ name, hasHeading: at > 0 }).toEqual({ name, hasHeading: true });
      const steps = lines.slice(at + 1).filter((l) => /^\d+\. \S/.test(l));
      expect({ name, steps: steps.length >= 1 && steps.length <= 2 })
        .toEqual({ name, steps: true });
      for (const step of steps) {
        expect(step.endsWith('.')).toBe(true);
      }
    }
  });

  test('every description links a runbook section that exists', () => {
    const anchors = runbookAnchors();
    const branch = environment === 'production' ? 'main' : 'staging';
    for (const { name, text } of descriptions()) {
      const link = /^Runbook: (\S+)$/m.exec(text);
      expect({ name, link: link !== null }).toEqual({ name, link: true });
      const match = new RegExp(
        `^https://github\\.com/The-Burnes-Center/a-iep/blob/${branch}/docs/RUNBOOK\\.md#(.+)$`,
      ).exec(link![1]);
      expect({ name, url: link![1], onThisBranch: match !== null })
        .toEqual({ name, url: link![1], onThisBranch: true });
      expect({ name, anchor: match![1], exists: anchors.has(match![1]) })
        .toEqual({ name, anchor: match![1], exists: true });
    }
  });

  // The words must be readable by someone who did not build the stack. A
  // CloudFormation logical id ends in an 8-character hash, a generated
  // function name starts with the stack name, and a token is not a string.
  test('no description contains a CloudFormation id, a token or a resource name', () => {
    const leaks: [RegExp, string][] = [
      [/\$\{Token\[/, 'unresolved token'],
      [/\{"(Ref|Fn::[A-Za-z]+)"/, 'intrinsic function'],
      [/AIEP(Staging)?Stack/, 'stack name'],
      [/\b[A-Z][A-Za-z0-9]+[0-9A-F]{8}\b/, 'logical id hash'],
      [/arn:aws/, 'ARN'],
      [/\b\d{12}\b/, 'account id'],
      [/\/aws\/lambda\//, 'log group name'],
      // Engineering labels from index.ts and new-auth.ts that must come out in
      // plain words: see PLAIN_NAMES.
      [/\(sends the SMS code\)|\(checks the SMS code\)|\(secures a new account\)/, 'engineering label'],
      [/\b(CreateAuthChallenge|VerifyAuthChallenge|DefineAuthChallenge|PreSignUp|PostConfirmation|PreAuthentication|CustomMessage)\b/, 'Cognito trigger name'],
    ];
    for (const { name, text } of descriptions()) {
      for (const [pattern, what] of leaks) {
        expect({ name, what, leaked: pattern.test(text) }).toEqual({ name, what, leaked: false });
      }
    }
  });

  test('no description uses an emoji or an em dash', () => {
    for (const { name, text } of descriptions()) {
      expect({ name, bad: /[—–\u{1F300}-\u{1FAFF}☀-➿]/u.test(text) })
        .toEqual({ name, bad: false });
    }
  });

  test('no two alarms in one environment share a headline', () => {
    const headlines = descriptions().map(({ text }) => TITLE.exec(text.split('\n')[0])![3]);
    const duplicated = headlines.filter((h, i) => headlines.indexOf(h) !== i);
    expect(duplicated).toEqual([]);
  });

  test('severity is a word, and staging is never CRITICAL', () => {
    for (const { name, text } of descriptions()) {
      const severity = TITLE.exec(text.split('\n')[0])![2];
      if (environment === 'staging') {
        expect({ name, severity: severity === 'CRITICAL' }).toEqual({ name, severity: false });
      }
    }
    const severities = new Set(descriptions().map(({ text }) => TITLE.exec(text.split('\n')[0])![2]));
    // The tiers all exist, so the mapping is not collapsing everything into one.
    expect(severities.has('WARNING')).toBe(true);
    expect(severities.has('INFO')).toBe(true);
    if (environment === 'production') expect(severities.has('CRITICAL')).toBe(true);
  });

  test('staging says no real families are affected, and prod states the impact', () => {
    for (const { name, text } of descriptions()) {
      const impact = /^Impact: (.*)$/m.exec(text)![1];
      if (environment === 'staging') {
        const ok = /^Staging only\. No real families are affected\.$/.test(impact)
          || /account-wide signal, so production is affected too/.test(impact);
        expect({ name, impact, ok }).toEqual({ name, impact, ok: true });
      } else {
        // Prod states a real impact: it is never the staging boilerplate.
        expect({ name, boilerplate: /^Staging only/.test(impact) }).toEqual({ name, boilerplate: false });
      }
    }
  });

  // Only CRITICAL alarms in prod post a resolution, so only those need to
  // say what is true once they clear. The rest are never shown one.
  test('every prod CRITICAL alarm says how it recovers', () => {
    if (environment !== 'production') return;
    for (const { name, text } of descriptions()) {
      if (!text.startsWith('[PROD] [CRITICAL]')) continue;
      const recovery = /^Recovery: (.+)$/m.exec(text);
      expect({ name, recovery: recovery !== null }).toEqual({ name, recovery: true });
      // Either what is true once it clears, or "quiet" for an alarm that
      // counts failures and so cannot claim anything was fixed.
      expect(recovery![1] === 'quiet' || recovery![1].length > 15).toBe(true);
    }
  });

  // The two alarms that skip the formatter fall back to Chatbot's raw card,
  // which cuts the description at about 250 characters. The headline and the
  // impact have to survive that.
  test('the formatter-bypass alarms lead with what matters', () => {
    for (const fragment of ['alerting itself is broken', 'alerts are not reaching the formatter']) {
      const alarm = alarms.find((a) => String(a.AlarmName).endsWith(fragment));
      expect(alarm).toBeDefined();
      const head = String(alarm!.AlarmDescription).slice(0, 250);
      expect(head).toContain(`[${label}]`);
      expect(head).toMatch(/Impact: .*\./);
    }
  });

  // The threshold in the words is read from the alarm, so it cannot drift.
  // This pins the derivation: a count alarm says its real threshold and window.
  test('the stated threshold and window match the alarm', () => {
    let checked = 0;
    for (const alarm of alarms) {
      const fires = /^Fires when: at least (\d+) .+ in (\d+) (seconds|minutes?|hours?)\.$/m
        .exec(alarm.AlarmDescription);
      if (!fires) continue;
      if (alarm.ComparisonOperator !== 'GreaterThanOrEqualToThreshold') continue;
      const unitSeconds: Record<string, number> = { second: 1, minute: 60, hour: 3600 };
      const span = Number(fires[2]) * unitSeconds[fires[3].replace(/s$/, '')];
      const period = alarm.Period ?? alarm.Metrics?.find((m: any) => m.ReturnData !== false)?.MetricStat?.Period;
      expect({ name: alarm.AlarmName, threshold: Number(fires[1]) })
        .toEqual({ name: alarm.AlarmName, threshold: alarm.Threshold });
      if (period) {
        expect({ name: alarm.AlarmName, span })
          .toEqual({ name: alarm.AlarmName, span: period * alarm.EvaluationPeriods });
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  });

  test('the alarm names did not change, so no alarm is replaced by this wording', () => {
    const prefix = environment === 'production' ? 'a-iep ' : 'a-iep-staging ';
    for (const alarm of alarms) {
      expect(String(alarm.AlarmName).startsWith(prefix)).toBe(true);
      // Names stay in the lowercase, human form they always had.
      expect(String(alarm.AlarmName).slice(prefix.length)).not.toMatch(/^\[/);
    }
  });
});

describe('the formatter fixture', () => {
  test('matches the synthesized descriptions', () => {
    const actual = JSON.stringify(rowsByEnvironment, null, 1) + '\n';
    if (process.env.UPDATE_ALARM_FIXTURE) {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, actual);
    }
    // If this fails, the wording changed: regenerate the fixture with
    // UPDATE_ALARM_FIXTURE=1 and let test_alert_formatter.py prove the
    // formatter still understands every description.
    expect(fs.readFileSync(FIXTURE, 'utf8')).toBe(actual);
  });
});

describe.each([
  ['staging', 'a-iep-staging *'],
  ['production', 'a-iep *'],
] as [Environment, string][])('what the alerting lambdas may touch (%s)', (environment, alarmPattern) => {
  let template: Template;

  beforeAll(() => {
    template = synth(environment);
  }, 180_000);

  // The formatter looks up how long an alert lasted. That is the only thing
  // it may read, and only for this environment's own alarms: the name prefix
  // is what keeps prod's formatter out of staging's history.
  test('the formatter can read alarm history for this environment only, and change nothing', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[])
      .filter((st) => JSON.stringify(st.Action).includes('cloudwatch:DescribeAlarmHistory'));
    expect(statements).toHaveLength(1);

    const [statement] = statements;
    expect(statement.Effect).toBe('Allow');
    expect(statement.Action).toBe('cloudwatch:DescribeAlarmHistory');
    const resource = JSON.stringify(statement.Resource);
    expect(resource).toContain(`:alarm:${alarmPattern}`);
    // Never "all alarms in the account": other projects' alarms are not ours to read.
    expect(resource).not.toMatch(/"\*"/);
    // The other environment's prefix is not a substring of this one's pattern.
    if (environment === 'production') expect(resource).not.toContain('a-iep-staging');
  });

  test('the daily brief names components in plain words', () => {
    const parameter = Object.values(template.findResources('AWS::SSM::Parameter'))
      .map((r: any) => r.Properties)
      .find((p: any) => String(p.Name ?? '').includes('daily-brief'));
    const raw = parameter.Value;
    const joined = typeof raw === 'string'
      ? raw
      : (raw['Fn::Join'][1] as any[])
          .map((part) => (typeof part === 'string' ? part : 'resolved-name'))
          .join(raw['Fn::Join'][0]);
    const labels: string[] = JSON.parse(joined).map((c: any) => c.label);

    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) {
      // An engineering label such as "CreateAuthChallenge (sends the SMS code)".
      expect(label).not.toMatch(/\(|Challenge|PreSignUp|PostConfirmation|CustomMessage|PreAuthentication/);
    }
    expect(labels).toContain('code sending');
    expect(labels).toContain('text extraction');
  });
});
