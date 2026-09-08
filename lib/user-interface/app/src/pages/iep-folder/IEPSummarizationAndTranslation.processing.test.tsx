/**
 * What the summary page does while the document is still being processed.
 *
 * The wait used to be ended by the PARENT: reaching the last carousel slide
 * flipped the page to its "completed" phase, which swapped the carousel for a
 * bare spinner with no way back. The wait is now ended by the DOCUMENT, and
 * these tests pin both halves of that — swiping the deck round changes
 * nothing, and the status landing on PROCESSED is what puts the parent on
 * their summary.
 *
 * Only the network boundary is mocked (`fetch`, plus Amplify's `Auth`). The
 * real ProcessingModal, ParentRightsCarousel, useDocumentFetch and
 * PollingManager all run, so unhooking any of them fails here.
 *
 * Also covers where this page sends a parent whose profile is unfinished,
 * which is the other way it can take the screen away from them.
 *
 * The translate-on-demand wiring lives in IEPSummarizationAndTranslation.test.tsx
 * and is not repeated here.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import IEPSummarizationAndTranslation from "./IEPSummarizationAndTranslation";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";

// signOut is stubbed so "the parent is still signed in" is an assertion about
// the real Amplify boundary rather than an assumption.
const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(),
  fetchAuthSession: vi.fn(), signOut: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);

const API_BASE = "https://api.example.test/api";
const CHILD_ID = "child-abc";
const IEP_ID = "doc-1";
const POLL_INTERVAL_MS = 5000;
const DOCUMENTS_URL = `${API_BASE}/profile/children/${CHILD_ID}/documents`;

const ENGLISH_SUMMARY = "The English summary paragraph.";
const PUBLIC_LANDING = "you are on the logged-out marketing site";
const ONBOARDING_LANDING = "you are on the preferred-language step";

/** The deck the page builds, in the order a parent meets it. */
const EXPECTED_DECK = [
  "section-what-aiep-does",
  "privacy-slide-1",
  "privacy-slide-2",
  "section-your-rights",
  "rights-slide-1",
  "rights-slide-2",
  "rights-slide-3",
  "rights-slide-4",
  "rights-slide-5",
  "rights-slide-6",
  "section-what-you-will-see-next",
  "tutorial-slide-1",
  "tutorial-slide-2",
  "tutorial-slide-3",
  "tutorial-slide-4",
];

/** One divider opens each of the deck's three sections. */
const DIVIDERS = [
  "section-what-aiep-does",
  "section-your-rights",
  "section-what-you-will-see-next",
];

const appConfig = {
  httpEndpoint: `${API_BASE}/`,
  enabledFeatures: [],
  enabledLanguages: ["en"],
} as unknown as AppConfig;

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const processingDocument = () => ({
  documentId: IEP_ID,
  status: "PROCESSING",
});

const processedDocument = () => ({
  documentId: IEP_ID,
  status: "PROCESSED",
  updatedAt: 1700000000,
  abbreviations: { en: [] },
  summaries: { en: ENGLISH_SUMMARY },
  document_index: { en: "" },
  sections: { en: [{ title: "Goals", content: "Goal content", page_numbers: [3] }] },
});

const finishedProfile = () => ({
  userId: "user-1",
  secondaryLanguage: "en",
  showOnboarding: false,
  children: [{ childId: CHILD_ID, name: "Child" }],
});

let documentPayload: Record<string, unknown>;
let profilePayload: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * t() is the identity so assertions read translation KEYS, except for the
 * indicator template: that one IS the contract the carousel formats against,
 * so the real English value is used.
 */
const translate = (key: string) =>
  key === "carousel.rights.indicator" ? "{number}. {title}" : key;

const renderPage = (language: SupportedLanguage = "en") => {
  const languageValue = {
    language,
    setLanguage: vi.fn(),
    t: translate,
    translationsLoaded: true,
    enabledLanguages: ["en"] as SupportedLanguage[],
  };

  render(
    <MemoryRouter initialEntries={["/summary-and-translations"]}>
      <AppContext.Provider value={appConfig}>
        <LanguageContext.Provider value={languageValue}>
            <Routes>
              <Route path="/summary-and-translations" element={<IEPSummarizationAndTranslation />} />
              <Route path="/iep-documents" element={<div>documents page</div>} />
              <Route path="/preferred-language" element={<div>{ONBOARDING_LANDING}</div>} />
              {/* The PUBLIC landing page. Its only route back into the app is
                  a link to /login, so an authenticated parent must never be
                  sent here. */}
              <Route path="/" element={<div>{PUBLIC_LANDING}</div>} />
            </Routes>
        </LanguageContext.Provider>
      </AppContext.Provider>
    </MemoryRouter>,
  );
};

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
};

const activeSlideId = () =>
  screen.getByTestId("carousel-active-slide").getAttribute("data-slide-id");

const clickNext = (times = 1) => {
  for (let i = 0; i < times; i += 1) {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  Auth.getCurrentUser.mockResolvedValue({ username: "test-user", userId: "test-user" });
  Auth.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { toString: () => "id-token", payload: {} } },
  });
  documentPayload = processingDocument();
  profilePayload = finishedProfile();

  fetchMock = vi.fn(async (url: string) => {
    if (url === `${API_BASE}/profile`) {
      return jsonResponse(200, { profile: profilePayload });
    }
    if (url === DOCUMENTS_URL) return jsonResponse(200, documentPayload);
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("while the document is processing", () => {
  test("the parent is kept company by the carousel", async () => {
    renderPage();
    await settle();

    expect(screen.getByTestId("processing-modal")).toBeInTheDocument();
    expect(screen.getByTestId("carousel-active-slide")).toBeInTheDocument();
    expect(activeSlideId()).toBe(EXPECTED_DECK[0]);
  });

  test("the deck is fifteen slides in three divided sections", async () => {
    renderPage();
    await settle();

    const visited = [activeSlideId()];
    for (let i = 1; i < EXPECTED_DECK.length; i += 1) {
      clickNext();
      visited.push(activeSlideId());
    }

    expect(visited).toEqual(EXPECTED_DECK);
    expect(visited).toHaveLength(15);
  });

  test("each divider sits immediately before the group it opens", async () => {
    renderPage();
    await settle();

    // Read the real order out of the DOM rather than off EXPECTED_DECK, so
    // this fails on its own if a divider drifts away from its group.
    const rendered: Array<{ id: string; type: string }> = [];
    for (let i = 0; i < EXPECTED_DECK.length; i += 1) {
      const card = screen.getByTestId("carousel-active-slide");
      rendered.push({
        id: card.getAttribute("data-slide-id") as string,
        type: card.getAttribute("data-slide-type") as string,
      });
      clickNext();
    }

    const slideAfter = (dividerId: string) =>
      rendered[rendered.findIndex((slide) => slide.id === dividerId) + 1];

    expect(rendered.filter((slide) => slide.type === "section").map((slide) => slide.id))
      .toEqual(DIVIDERS);
    expect(slideAfter("section-what-aiep-does")).toEqual({ id: "privacy-slide-1", type: "privacy" });
    expect(slideAfter("section-your-rights")).toEqual({ id: "rights-slide-1", type: "rights" });
    // The tutorial slides used to trail the rights with nothing announcing them.
    expect(slideAfter("section-what-you-will-see-next"))
      .toEqual({ id: "tutorial-slide-1", type: "tutorial" });
  });

  test("each right is headed by its own number and title", async () => {
    renderPage();
    await settle();

    const indicators = screen.getAllByTestId("rights-indicator");

    expect(indicators).toHaveLength(6);
    expect(indicators.map((node) => node.textContent)).toEqual([
      "1. rights.slide1.title",
      "2. rights.slide2.title",
      "3. rights.slide3.title",
      "4. rights.slide4.title",
      "5. rights.slide5.title",
      "6. rights.slide6.title",
    ]);
  });

  test("swiping past the end wraps instead of ending the wait", async () => {
    renderPage();
    await settle();

    // A full lap and change: the deck used to hand the parent a bare spinner
    // the moment they reached the end, with no way back to it.
    clickNext(EXPECTED_DECK.length + 2);

    expect(screen.getByTestId("processing-modal")).toBeInTheDocument();
    expect(screen.getByTestId("carousel-active-slide")).toBeInTheDocument();
    expect(activeSlideId()).toBe(EXPECTED_DECK[2]);
    // Still the carousel screen, not the phase that replaces it.
    expect(screen.getAllByTestId("rights-indicator")).toHaveLength(6);
  });

  test("swiping does not put the parent on the summary", async () => {
    renderPage();
    await settle();

    clickNext(EXPECTED_DECK.length * 2);

    expect(screen.queryByTestId("summary-text-en")).not.toBeInTheDocument();
    expect(screen.getByTestId("processing-modal")).toBeInTheDocument();
  });
});

describe("when processing finishes", () => {
  test("the status alone puts the parent on their summary", async () => {
    renderPage();
    await settle();
    expect(screen.getByTestId("processing-modal")).toBeInTheDocument();

    documentPayload = processedDocument();
    await settle(POLL_INTERVAL_MS);

    expect(screen.queryByTestId("processing-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("summary-text-en")).toHaveTextContent(ENGLISH_SUMMARY);
  });

  test("it lands the parent there even if they never touched the carousel", async () => {
    renderPage();
    await settle();

    // Not a single click: nothing about the parent's progress through the deck
    // is an input to finishing.
    documentPayload = processedDocument();
    await settle(POLL_INTERVAL_MS);

    expect(screen.getByTestId("summary-text-en")).toBeInTheDocument();
    expect(screen.queryByTestId("carousel-active-slide")).not.toBeInTheDocument();
  });

  test("a failed document leaves the carousel too, for its own message", async () => {
    renderPage();
    await settle();

    documentPayload = { documentId: IEP_ID, status: "FAILED" };
    await settle(POLL_INTERVAL_MS);

    expect(screen.queryByTestId("processing-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("summary-failed")).toBeInTheDocument();
  });
});

describe("when the parent's profile is not finished yet", () => {
  // Reached by tapping "Summary" in the bottom nav before onboarding is done.
  // It used to redirect to '/', the PUBLIC landing page, whose only way back
  // in is a link to /login: the parent was still signed in but was looking at
  // the marketing site and a sign-in form, which reads as "it logged me out".
  const arriveMidOnboarding = async () => {
    profilePayload = { ...finishedProfile(), showOnboarding: true };
    renderPage();
    await settle();
  };

  test("they are sent to the onboarding step, not to the public site", async () => {
    await arriveMidOnboarding();

    expect(screen.getByText(ONBOARDING_LANDING)).toBeInTheDocument();
    expect(screen.queryByText(PUBLIC_LANDING)).not.toBeInTheDocument();
  });

  test("and they are still signed in when they get there", async () => {
    await arriveMidOnboarding();

    // The redirect is a redirect, not a sign-out: nothing on this path may
    // touch the Amplify session, and the authenticated calls kept working.
    expect(Auth.signOut).not.toHaveBeenCalled();
    // v6: authenticated calls read the session (fetchAuthSession), not the user object.
    expect(Auth.fetchAuthSession).toHaveBeenCalled();
    expect(screen.queryByText(PUBLIC_LANDING)).not.toBeInTheDocument();
  });

  test("a finished profile is left on the summary page", async () => {
    // Control for the two above: the redirect must fire on the flag, not on
    // every render of this page.
    documentPayload = processedDocument();
    renderPage();
    await settle();

    expect(screen.getByTestId("summary-text-en")).toBeInTheDocument();
    expect(screen.queryByText(ONBOARDING_LANDING)).not.toBeInTheDocument();
    expect(screen.queryByText(PUBLIC_LANDING)).not.toBeInTheDocument();
  });
});
