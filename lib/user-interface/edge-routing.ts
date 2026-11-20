// The viewer-request CloudFront Function in front of the website bucket.
//
// It does one thing: www.a-iep.org is the same site under a second name, so
// any www. host gets a 301 to the same path and query on the apex. Every
// other request goes on to S3 untouched, and the SPA fallback in
// generate-app.ts serves it as before.
//
// Staging carries the full version of this file (page routing, prerendered
// pages, real 404s). It keeps this construct and this redirect, so promoting
// it updates the function in place.

/**
 * The hostnames the distribution answers to. An apex domain (a-iep.org, prod)
 * also answers for its www name, which the function sends on to the apex; a
 * subdomain (dev.a-iep.org, staging) answers for itself only. The certificate
 * has to cover every name here, or CloudFormation rejects the distribution.
 */
export function distributionAliases(domain: string): string[] {
  return domain.split(".").length === 2 ? [domain, `www.${domain}`] : [domain];
}

/**
 * The function's source. CloudFront Functions run their own JavaScript
 * runtime (cloudfront-js-2.0), so this is a plain string of ES5-style code.
 */
export function buildViewerRequestFunction(): string {
  return `function queryString(qs) {
  var parts = [];
  for (var name in qs) {
    var entry = qs[name];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? name : name + '=' + values[i].value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function handler(event) {
  var request = event.request;
  // The path is kept as asked: a referral code in /r/:code is case-sensitive.
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  if (host.indexOf('www.') === 0) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://' + host.slice(4) + request.uri + queryString(request.querystring) } }
    };
  }
  return request;
}
`;
}
