/**
 * More than one child per account (the multiChild feature), through the real
 * screens: which child each one is about, and what a parent with one child
 * still sees.
 *
 * The failure all of this exists to prevent is one child's IEP shown, read or
 * uploaded under another's name, so most cases assert which child's URL the
 * network was called with, and that the other child's never was. Only the
 * network boundary (fetch, Amplify's Auth) is mocked, as in the summary
 * page's own suites.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppContext } from "../../common/app-context";
import { LanguageContext } from "../../common/language-context";
import type { AppConfig } from "../../common/types";
import type { SupportedLanguage } from "../../common/languages";
import ChildBar from "../../components/ChildBar";
import MyChildren from "./MyChildren";
import AddChild from "./AddChild";
import UploadIEPDocument from "../iep-folder/UploadIEPDocument";
import SummaryAndTranslationsPage from "../iep-folder/SummaryAndTranslationsPage";
import { childDocumentState } from "./my-children-status";

const Auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(), fetchAuthSession: vi.fn() }));
vi.mock("aws-amplify/auth", () => Auth);
// The S3 PUT itself: which child the upload is for is decided by the
// signed-URL request before it, which is what these tests read.
vi.mock("../../common/file-uploader", () => ({
  FileUploader: class { upload = vi.fn(async () => undefined); },
}));

const API = "https://api.example.test/api";
const MAYA = { childId: "c-maya", name: "Maya Lopez", schoolCity: "Lakeview" };
const LEO = { childId: "c-leo", name: "Leo Lopez", schoolCity: "Lakeview" };

let children: Array<typeof MAYA>;
let documents: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
type FetchImpl = (url: string, init?: RequestInit) => Promise<unknown>;

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
const docsUrl = (childId: string) => `${API}/profile/children/${childId}/documents`;

/** Where the router ended up, for navigation assertions. */
function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

const renderAt = (path: string, element: React.ReactNode, { multiChild = true } = {}) => {
  const appConfig = {
    httpEndpoint: `${API}/`,
    enabledFeatures: multiChild ? ["multiChild"] : [],
    enabledLanguages: ["en"],
  } as unknown as AppConfig;
  const pathname = path.split("?")[0];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <AppContext.Provider value={appConfig}>
          <LanguageContext.Provider
            value={{
              language: "en" as SupportedLanguage,
              setLanguage: vi.fn(),
              t: (key: string) => key,
              translationsLoaded: true,
              enabledLanguages: ["en"] as SupportedLanguage[],
            }}
          >
            <Routes>
              <Route path={pathname} element={element} />
              <Route path="*" element={null} />
            </Routes>
            <Where />
          </LanguageContext.Provider>
        </AppContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(10);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/");
  Auth.getCurrentUser.mockResolvedValue({ username: "u", userId: "u" });
  Auth.fetchAuthSession.mockResolvedValue({ tokens: { idToken: { toString: () => "tok", payload: {} } } });
  children = [MAYA, LEO];
  documents = {
    [MAYA.childId]: { documentId: "d-maya", status: "PROCESSED", summaries: { en: "Maya summary" }, sections: { en: [] }, document_index: { en: "" }, abbreviations: { en: [] } },
    [LEO.childId]: { message: "No document found for this child" },
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${API}/profile` && (!init || init.method !== "PUT")) {
      return json(200, { profile: { userId: "u", secondaryLanguage: "en", showOnboarding: false, consentGiven: true, summaryTourSeen: true, children } });
    }
    const docs = /\/profile\/children\/([^/]+)\/documents$/.exec(url);
    if (docs) return json(200, documents[docs[1]] ?? { message: "No document found for this child" });
    if (url === `${API}/profile/children` && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return json(200, { childId: "c-new", name: body.name });
    }
    if (url === `${API}/signed-url-knowledge`) return json(200, { signedUrl: "https://s3.example.test/put" });
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what My children says about each IEP", () => {
  test.each([
    [{ status: "PROCESSED" }, false, "ready"],
    [{ status: "FAILED" }, false, "failed"],
    [{ status: "PROCESSING" }, false, "reading"],
    [{ status: "PROCESSING_TRANSLATIONS" }, false, "reading"],
    [{ status: "PENDING_UPLOAD" }, false, "reading"],
    [{}, false, "reading"],
    [{ message: "No document found for this child" }, false, "none"],
    [null, false, "none"],
    [{ status: "PROCESSED" }, true, "unknown"],
    [{ status: "SOMETHING_NEW" }, false, "unknown"],
  ])("%j (load failed: %s) is %s", (answer, failed, state) => {
    expect(childDocumentState(answer, failed)).toBe(state);
  });
});

describe("the child bar", () => {
  test("names the child the URL is about, and where they sit in the family", async () => {
    renderAt("/x?child=c-leo", <ChildBar />);
    await settle();

    expect(screen.getByTestId("child-bar-name")).toHaveTextContent("childBar.whoseIep");
    expect(screen.getByTestId("child-bar")).toHaveTextContent("childBar.position");
    expect(screen.getByTestId("child-bar-switch")).toHaveAttribute("href", "/account-center/children");
  });

  test("is not there for a family with one child, so their screens are prod's", async () => {
    children = [MAYA];
    renderAt("/x", <ChildBar />);
    await settle();

    expect(screen.queryByTestId("child-bar")).not.toBeInTheDocument();
  });

  test("is not there with the feature off, however many children there are", async () => {
    renderAt("/x?child=c-leo", <ChildBar />, { multiChild: false });
    await settle();

    expect(screen.queryByTestId("child-bar")).not.toBeInTheDocument();
  });
});

describe("My children", () => {
  test("shows each child's state in words, with the one next step for each", async () => {
    vi.useRealTimers();
    renderAt("/account-center/children", <MyChildren />);
    // Each card's read starts only once the profile has answered.
    await waitFor(() => expect(screen.getAllByTestId("my-children-status")).toHaveLength(2));

    const cards = screen.getAllByTestId("my-children-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("Maya Lopez");
    expect(cards[0]).toHaveTextContent("myChildren.status.ready");
    expect(cards[0].querySelector("a")).toHaveAttribute("href", "/summary-and-translations?child=c-maya");
    expect(cards[1]).toHaveTextContent("myChildren.status.none");
    expect(cards[1].querySelector("a")).toHaveAttribute("href", "/iep-documents?child=c-leo");
  });

  test("asks the server about each child, by that child's own id", async () => {
    renderAt("/account-center/children", <MyChildren />);
    await settle();

    expect(urls()).toContain(docsUrl(MAYA.childId));
    expect(urls()).toContain(docsUrl(LEO.childId));
  });

  test("says it could not check, and offers to try again, when a child's read fails", async () => {
    const base = fetchMock.getMockImplementation() as FetchImpl;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === docsUrl(LEO.childId) ? json(500, {}) : base(url, init));

    vi.useRealTimers();
    renderAt("/account-center/children", <MyChildren />);
    await waitFor(() => expect(screen.getAllByTestId("my-children-status")).toHaveLength(2));

    const leoCard = screen.getAllByTestId("my-children-card")[1];
    expect(leoCard).toHaveTextContent("myChildren.status.unknown");
    expect(leoCard).toHaveTextContent("myChildren.action.retry");
  });

  test("sends a parent back to Account when the feature is off", async () => {
    renderAt("/account-center/children", <MyChildren />, { multiChild: false });
    await settle();

    expect(screen.getByTestId("where")).toHaveTextContent("/account-center");
    expect(screen.queryByTestId("my-children-card")).not.toBeInTheDocument();
  });
});

describe("adding a child", () => {
  test("refuses a name with no letter in it, and asks the server nothing", async () => {
    renderAt("/account-center/children/add", <AddChild />);
    await settle();

    fireEvent.change(screen.getByTestId("add-child-name"), { target: { value: "123" } });
    fireEvent.click(screen.getByTestId("add-child-save"));
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent("child.name.error.invalid");
    expect(urls().some((u) => u.endsWith("/profile/children"))).toBe(false);
  });

  test("adds the child, then goes straight to uploading THEIR IEP", async () => {
    renderAt("/account-center/children/add", <AddChild />);
    await settle();

    fireEvent.change(screen.getByTestId("add-child-name"), { target: { value: "  Sam   Lopez " } });
    fireEvent.change(screen.getByTestId("add-child-school"), { target: { value: "Lakeview" } });
    fireEvent.click(screen.getByTestId("add-child-save"));
    await settle();

    const post = fetchMock.mock.calls.find(([u, init]) => String(u).endsWith("/profile/children") && init?.method === "POST");
    expect(JSON.parse(String(post?.[1].body))).toEqual({ name: "Sam Lopez", schoolCity: "Lakeview" });
    expect(screen.getByTestId("where")).toHaveTextContent("/iep-documents?child=c-new");
  });

  test("says so, and stays put, when the server will not add the child", async () => {
    const base = fetchMock.getMockImplementation() as FetchImpl;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith("/profile/children") && init?.method === "POST" ? json(400, {}) : base(url, init));
    renderAt("/account-center/children/add", <AddChild />);
    await settle();

    fireEvent.change(screen.getByTestId("add-child-name"), { target: { value: "Sam Lopez" } });
    fireEvent.click(screen.getByTestId("add-child-save"));
    await settle();

    expect(screen.getByText("addChild.error.saveFailed")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/account-center/children/add");
  });
});

describe("uploading for one of several children", () => {
  const pickFile = () =>
    fireEvent.change(document.getElementById("fileUpload")!, {
      target: { files: [new File(["hello"], "iep.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })] },
    });

  test("says whose IEP it will be before the parent sends it, and sends it as theirs", async () => {
    renderAt("/iep-documents?child=c-leo", <UploadIEPDocument onUploadComplete={vi.fn()} hasExistingDocument={false} />);
    await settle();

    pickFile();
    await settle();
    expect(screen.getByTestId("upload-belongs-to")).toHaveTextContent("upload.belongsTo");
    expect(screen.getByTestId("upload-submit-button")).toHaveTextContent("upload.buttonForChild");

    fireEvent.click(screen.getByTestId("upload-submit-button"));
    await settle();

    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/signed-url-knowledge"));
    expect(JSON.parse(String(call?.[1].body))).toMatchObject({ childId: LEO.childId, operation: "upload" });
  });

  test("a family with one child sees the upload exactly as before", async () => {
    children = [MAYA];
    renderAt("/iep-documents", <UploadIEPDocument onUploadComplete={vi.fn()} hasExistingDocument={false} />);
    await settle();

    pickFile();
    await settle();
    expect(screen.queryByTestId("upload-belongs-to")).not.toBeInTheDocument();
    expect(screen.getByTestId("upload-submit-button")).toHaveTextContent("upload.button");
  });
});

describe("the summary for one of several children", () => {
  test("reads only that child's document, never the first child's on the way", async () => {
    window.history.replaceState(null, "", "/summary-and-translations?child=c-leo");
    documents[LEO.childId] = { ...(documents[MAYA.childId] as object), documentId: "d-leo", summaries: { en: "Leo summary" } };
    renderAt("/summary-and-translations?child=c-leo", <SummaryAndTranslationsPage />);
    await settle();

    expect(urls()).toContain(docsUrl(LEO.childId));
    expect(urls()).not.toContain(docsUrl(MAYA.childId));
  });
});
