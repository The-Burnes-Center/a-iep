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
import ChildForm from "./ChildForm";
import UploadIEPDocument from "../iep-folder/UploadIEPDocument";
import SummaryAndTranslationsPage from "../iep-folder/SummaryAndTranslationsPage";
import ProcessingModal from "../../components/ProcessingModal";
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
  window.sessionStorage.clear();
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
    const one = /\/profile\/children\/([^/]+)$/.exec(url);
    if (one && (init?.method === "PUT" || init?.method === "DELETE")) return json(200, { childId: one[1] });
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
  test("names the child the URL is about, and offers the app's own switch button", async () => {
    renderAt("/x?child=c-leo", <ChildBar />);
    await settle();

    expect(screen.getByTestId("child-bar-name")).toHaveTextContent("childBar.whoseIep");
    const switchLink = screen.getByTestId("child-bar-switch");
    expect(switchLink).toHaveAttribute("href", "/account-center/children");
    // The shared outline pill, not a bare text link.
    expect(switchLink).toHaveClass("ui-button", "ui-button--secondary");
    // Its accessible name says where it goes, and still contains the visible word.
    expect(switchLink).toHaveAccessibleName("childBar.switchLabel");
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

    expect(screen.getByTestId("where")).toHaveTextContent(/^\/account-center$/);
    expect(screen.queryByTestId("my-children-card")).not.toBeInTheDocument();
  });
});

describe("adding a child", () => {
  test("refuses a name with no letter in it, and asks the server nothing", async () => {
    renderAt("/account-center/children/add", <ChildForm mode="add" />);
    await settle();

    fireEvent.change(screen.getByTestId("add-child-name"), { target: { value: "123" } });
    fireEvent.click(screen.getByTestId("add-child-save"));
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent("child.name.error.invalid");
    expect(urls().some((u) => u.endsWith("/profile/children"))).toBe(false);
  });

  test("adds the child, then goes straight to uploading THEIR IEP", async () => {
    renderAt("/account-center/children/add", <ChildForm mode="add" />);
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
    renderAt("/account-center/children/add", <ChildForm mode="add" />);
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

  test("a link that names no child (the Summary tab, Show me around) stays on the child last opened", async () => {
    documents[LEO.childId] = { ...(documents[MAYA.childId] as object), documentId: "d-leo", summaries: { en: "Leo summary" } };
    window.history.replaceState(null, "", "/summary-and-translations?child=c-leo");
    const first = renderAt("/summary-and-translations?child=c-leo", <SummaryAndTranslationsPage />);
    await settle();
    first.unmount();
    fetchMock.mockClear();

    window.history.replaceState(null, "", "/summary-and-translations");
    renderAt("/summary-and-translations", <SummaryAndTranslationsPage />);
    await settle();
    expect(urls()).toContain(docsUrl(LEO.childId));
    expect(urls()).not.toContain(docsUrl(MAYA.childId));
  });
});

describe("the processing screen for one of several children", () => {
  const renderModal = (childLabel?: string) =>
    render(
      <ProcessingModal
        error={null}
        childLabel={childLabel}
        tutorialPhase="completed"
        t={(key: string) => key}
        parentRightsSlideData={[]}
        headerPinkTitle=""
        headerGreenTitle=""
        rightsIndicatorTemplate=""
        progressDocument={{ status: "PROCESSING" } as never}
        progressStepLabel="step"
        pollingStopped={false}
        onCheckAgain={vi.fn()}
      />,
    );

  test("says whose IEP is being read, above the headline", () => {
    renderModal("Leo Lopez's IEP");
    expect(screen.getByTestId("processing-child")).toHaveTextContent("Leo Lopez's IEP");
  });

  test("says nothing extra for a family with one child", () => {
    renderModal(undefined);
    expect(screen.queryByTestId("processing-child")).not.toBeInTheDocument();
  });
});

const calls = (method: string) =>
  fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method).map(([u]) => String(u));

describe("editing a child", () => {
  test("opens with that child's details, and saves only that child", async () => {
    vi.useRealTimers();
    renderAt("/account-center/children/edit?child=c-leo", <ChildForm mode="edit" />);
    await waitFor(() => expect(screen.getByTestId("add-child-name")).toHaveValue("Leo Lopez"));
    expect(screen.getByTestId("add-child-school")).toHaveValue("Lakeview");

    fireEvent.change(screen.getByTestId("add-child-name"), { target: { value: "Leo  Lopez-Diaz" } });
    fireEvent.click(screen.getByTestId("add-child-save"));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/account-center\/children$/));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(String(put?.[0])).toBe(`${API}/profile/children/${LEO.childId}`);
    expect(JSON.parse(String(put?.[1].body))).toEqual({ name: "Leo Lopez-Diaz", schoolCity: "Lakeview" });
    // Never the whole-list write that would drop the other child.
    expect(calls("PUT")).not.toContain(`${API}/profile`);
  });

  test("goes back to the list, rather than opening the first child, for a child not on this profile", async () => {
    vi.useRealTimers();
    renderAt("/account-center/children/edit?child=someone-else", <ChildForm mode="edit" />);

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/account-center\/children$/));
    expect(screen.queryByTestId("add-child-name")).not.toBeInTheDocument();
  });
});

describe("removing a child", () => {
  const openList = async () => {
    vi.useRealTimers();
    renderAt("/account-center/children", <MyChildren />);
    await waitFor(() => expect(screen.getAllByTestId("my-children-status")).toHaveLength(2));
  };

  test("asks first, says it is permanent, and deletes nothing until the parent confirms", async () => {
    await openList();
    fireEvent.click(screen.getAllByTestId("my-children-remove")[1]);

    expect(screen.getByTestId("my-children-confirm")).toHaveTextContent("myChildren.remove.confirmBody");
    expect(calls("DELETE")).toEqual([]);
    // Focus lands on the decision.
    expect(screen.getByTestId("my-children-confirm-remove")).toHaveFocus();
  });

  test("removes exactly the child confirmed, and no one else", async () => {
    await openList();
    fireEvent.click(screen.getAllByTestId("my-children-remove")[1]);
    fireEvent.click(screen.getByTestId("my-children-confirm-remove"));

    await waitFor(() => expect(calls("DELETE")).toEqual([`${API}/profile/children/${LEO.childId}`]));
  });

  test("keeping the child closes the question and deletes nothing", async () => {
    await openList();
    fireEvent.click(screen.getAllByTestId("my-children-remove")[1]);
    fireEvent.click(screen.getByText("myChildren.remove.keep"));

    expect(screen.queryByTestId("my-children-confirm")).not.toBeInTheDocument();
    expect(calls("DELETE")).toEqual([]);
  });

  test("says so, and keeps the question open, when the server will not remove the child", async () => {
    const base = fetchMock.getMockImplementation() as FetchImpl;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? json(500, {}) : base(url, init));
    await openList();
    fireEvent.click(screen.getAllByTestId("my-children-remove")[1]);
    fireEvent.click(screen.getByTestId("my-children-confirm-remove"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("myChildren.remove.failed"));
    expect(screen.getByTestId("my-children-confirm")).toBeInTheDocument();
  });

  test("is not offered for the only child: an account always has one", async () => {
    children = [MAYA];
    vi.useRealTimers();
    renderAt("/account-center/children", <MyChildren />);
    await waitFor(() => expect(screen.getAllByTestId("my-children-status")).toHaveLength(1));

    expect(screen.queryByTestId("my-children-remove")).not.toBeInTheDocument();
    expect(screen.getByTestId("my-children-edit")).toBeInTheDocument();
  });
});
