/**
 * The viewer-request CloudFront Function (lib/user-interface/edge-routing.ts).
 *
 * The function's source is a string CloudFront runs in its own runtime, so
 * these tests run that exact string: they build it, evaluate it, and call
 * handler() with events shaped like the ones CloudFront sends
 * (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html).
 */
import { buildViewerRequestFunction, distributionAliases } from '../../lib/user-interface/edge-routing';

type Handler = (event: unknown) => any;
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the shipped string is the point
const handler = new Function(`${buildViewerRequestFunction()}\nreturn handler;`)() as Handler;

function request(uri: string, opts: { host?: string; querystring?: Record<string, unknown> } = {}) {
  return handler({
    version: '1.0',
    context: { eventType: 'viewer-request' },
    viewer: { ip: '192.0.2.1' },
    request: {
      method: 'GET',
      uri,
      querystring: opts.querystring ?? {},
      headers: opts.host ? { host: { value: opts.host } } : {},
      cookies: {},
    },
  });
}

// www.a-iep.org answered with a TLS error (525) at the CDN, because the
// distribution only knew a-iep.org. It now answers for both, and this sends
// www to the one name a crawler and the canonical link use.
describe('www is a 301 to the apex', () => {
  test('the home page', () => {
    const res = request('/', { host: 'www.a-iep.org' });
    expect([res.statusCode, res.headers?.location?.value]).toEqual([301, 'https://a-iep.org/']);
  });

  test('keeps the path exactly, since a referral code is case-sensitive', () => {
    expect(request('/r/AbC123', { host: 'www.a-iep.org' }).headers?.location?.value).toBe('https://a-iep.org/r/AbC123');
  });

  test('keeps the query string, and any case of the host', () => {
    const res = request('/faqs', { host: 'WWW.a-iep.org', querystring: { utm_source: { value: 'flyer' } } });
    expect(res.headers?.location?.value).toBe('https://a-iep.org/faqs?utm_source=flyer');
  });

  test('the apex and staging go on to S3 untouched', () => {
    for (const host of ['a-iep.org', 'dev.a-iep.org']) {
      const res = request('/r/AbC123', { host });
      expect([host, res.statusCode, res.uri]).toEqual([host, undefined, '/r/AbC123']);
    }
  });
});

describe('the names the distribution answers to', () => {
  test('an apex domain answers for its www name too', () => {
    expect(distributionAliases('a-iep.org')).toEqual(['a-iep.org', 'www.a-iep.org']);
  });

  // Staging's certificate covers dev.a-iep.org only, so a www alias there
  // would fail the deploy.
  test('a subdomain answers for itself only', () => {
    expect(distributionAliases('dev.a-iep.org')).toEqual(['dev.a-iep.org']);
  });
});
