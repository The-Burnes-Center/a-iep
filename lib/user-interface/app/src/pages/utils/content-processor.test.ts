/**
 * Jargon highlighting in the summary, and the two different strings it has to
 * carry at once.
 *
 * The term regex is case-insensitive on purpose: a document that writes
 * "accommodations" mid-sentence should still get the word highlighted. What
 * the drawer needs, though, is the dictionary's own spelling, and that used to
 * be thrown away — the span wrapped the matched text and nothing else, so a
 * lowercase occurrence gave the drawer a lowercase title. The span now carries
 * `data-term` (the dictionary key) alongside `data-tooltip` (the definition),
 * and the visible text is left exactly as the document phrased it. That text is
 * the child's document; it is not ours to re-case on screen.
 *
 * Everything here asserts on parsed DOM nodes rather than on the HTML string,
 * because DOMPurify re-serializes what it sanitizes: `&#39;` comes back out as
 * a bare apostrophe, and comparing raw strings would pin the serializer
 * instead of the attribute value the drawer actually reads.
 */
import { describe, expect, test } from "vitest";
import DOMPurify from "dompurify";
import { processContentWithJargon } from "./content-processor";
import enGlossary from "../glossary/english.json";

const parse = (html: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
};

const jargonSpans = (html: string): HTMLElement[] =>
  Array.from(parse(html).querySelectorAll("span.jargon-term"));

describe("the term the drawer is given", () => {
  test("is the dictionary's spelling, not the document's", () => {
    const html = processContentWithJargon(
      "The team agreed on accommodations for reading.",
      "en",
    );
    const spans = jargonSpans(html);

    expect(spans).toHaveLength(1);
    expect(spans[0].getAttribute("data-term")).toBe("Accommodations");
  });

  test("is still the dictionary's spelling when the document shouts", () => {
    const spans = jargonSpans(
      processContentWithJargon("Read the PROCEDURAL SAFEGUARDS notice.", "en"),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0].getAttribute("data-term")).toBe("Procedural Safeguards");
  });

  test("survives DOMPurify, which is what the highlighted content is run through", () => {
    // DOMPurify 3 allows data-* attributes by default (ALLOW_DATA_ATTR), which
    // is the only reason a plain data attribute works here. This fails if that
    // default is ever configured away, before the drawer silently goes back to
    // reading the raw text.
    const span =
      '<span class="jargon-term" data-term="Accommodations" data-tooltip="A definition.">accommodations</span>';

    expect(DOMPurify.sanitize(span)).toContain('data-term="Accommodations"');
  });
});

describe("the text a parent reads", () => {
  test("keeps the document's own casing inside the highlight", () => {
    const spans = jargonSpans(
      processContentWithJargon("The team agreed on accommodations for reading.", "en"),
    );

    expect(spans[0].textContent).toBe("accommodations");
  });

  test("is unchanged, word for word, around the highlight", () => {
    const sentence = "The team agreed on accommodations for reading.";

    expect(parse(processContentWithJargon(sentence, "en")).textContent?.trim()).toBe(
      sentence,
    );
  });

  test("is left alone entirely in a language with no glossary", () => {
    const html = processContentWithJargon("Se acordaron accommodations.", "ar");

    expect(jargonSpans(html)).toHaveLength(0);
    expect(parse(html).textContent?.trim()).toBe("Se acordaron accommodations.");
  });
});

describe("definitions that contain quotes", () => {
  test("round-trip through the attribute exactly as the dictionary wrote them", () => {
    // Abeyance's definition is double-quoted mid-sentence and Adaptive
    // Software's has an apostrophe, so between them they cover both escapes.
    const quoted = jargonSpans(processContentWithJargon("Held in abeyance.", "en"));
    const apostrophe = jargonSpans(
      processContentWithJargon("They bought adaptive software.", "en"),
    );

    expect(quoted[0].getAttribute("data-tooltip")).toBe(enGlossary.Abeyance);
    expect(quoted[0].getAttribute("data-tooltip")).toContain('"temporary."');
    expect(apostrophe[0].getAttribute("data-tooltip")).toBe(
      enGlossary["Adaptive Software"],
    );
    expect(apostrophe[0].getAttribute("data-tooltip")).toContain("student's");
  });

  test("do not leak out of the attribute into the page", () => {
    const html = processContentWithJargon("Held in abeyance.", "en");

    expect(jargonSpans(html)).toHaveLength(1);
    expect(parse(html).textContent?.trim()).toBe("Held in abeyance.");
  });
});

describe("a term nested inside a longer term", () => {
  test("is not wrapped a second time", () => {
    // "Assessment Plan" is matched first (terms run longest-first), and the
    // "Assessment" pass that follows finds its own word both in that span's
    // text and in its data-term attribute. Neither may be re-wrapped.
    const html = processContentWithJargon("The assessment plan arrives next week.", "en");
    const spans = jargonSpans(html);

    expect(spans).toHaveLength(1);
    expect(spans[0].getAttribute("data-term")).toBe("Assessment Plan");
    expect(spans[0].textContent).toBe("assessment plan");
    expect(spans[0].querySelector("span")).toBeNull();
    expect(parse(html).textContent?.trim()).toBe("The assessment plan arrives next week.");
  });
});
