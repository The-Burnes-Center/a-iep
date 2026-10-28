/**
 * The JSON-LD block in index.html, which every prerendered page carries too.
 * Search engines and assistants read the publisher's contact point and
 * address to tell a real organization from a lookalike, so both must be
 * present and must agree with what the app itself tells parents.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
const PRIVACY_POLICY = fs.readFileSync(path.join(__dirname, "..", "pages", "PrivacyPolicy.tsx"), "utf8");

function structuredData() {
  const blocks = [...INDEX_HTML.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(blocks).toHaveLength(1);
  return JSON.parse(blocks[0][1]);
}

describe("structured data", () => {
  test("is valid JSON describing the app", () => {
    const data = structuredData();
    expect(data["@context"]).toBe("https://schema.org");
    expect(data["@type"]).toBe("WebApplication");
    expect(data.url).toBe("https://a-iep.org/");
  });

  test("names the publisher with a postal address", () => {
    const { publisher } = structuredData();
    expect(publisher["@type"]).toBe("Organization");
    expect(publisher.address).toEqual(expect.objectContaining({
      "@type": "PostalAddress",
      streetAddress: expect.any(String),
      addressLocality: "Boston",
      addressRegion: "MA",
      postalCode: expect.stringMatching(/^\d{5}$/),
      addressCountry: "US",
    }));
  });

  test("gives a contact point that matches the privacy policy's contact", () => {
    const { contactPoint } = structuredData().publisher;
    expect(contactPoint["@type"]).toBe("ContactPoint");
    expect(contactPoint.contactType).toBeTruthy();
    // The address the policy shows parents; a second, different address in
    // the metadata would be the one nobody reads.
    expect(PRIVACY_POLICY).toContain(`mailto:${contactPoint.email}`);
    expect(contactPoint.url).toBe("https://a-iep.org/public-privacy-policy#contact");
    expect(PRIVACY_POLICY).toContain('id="contact"');
  });
});
