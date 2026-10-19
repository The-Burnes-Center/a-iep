/**
 * WebOTP (SMS code autofill) on the one-time-code field.
 *
 * The browser API is stubbed per test: `window.OTPCredential` for detection
 * and `navigator.credentials.get` for the request. Both are restored after
 * each test, so no other suite sees them.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VerificationCodeInput from "./VerificationCodeInput";

/** A request the test resolves or rejects by hand, after it has been made. */
interface PendingRequest {
  resolve: (credential: unknown) => void;
  reject: (error: unknown) => void;
}

const originalCredentials = Object.getOwnPropertyDescriptor(navigator, "credentials");

const stubOtpSupport = (supported: boolean) => {
  if (supported) {
    Object.defineProperty(window, "OTPCredential", { configurable: true, value: class {} });
  } else {
    delete (window as { OTPCredential?: unknown }).OTPCredential;
  }
};

/** Installs navigator.credentials.get as a mock that returns `result` for each call. */
const stubCredentialsGet = (result: () => Promise<unknown>) => {
  const get = vi.fn<[unknown?], Promise<unknown>>(() => result());
  Object.defineProperty(navigator, "credentials", { configurable: true, value: { get } });
  return get;
};

/** A get() whose outcome the test controls, after the component has made the call. */
const stubPendingCredentialsGet = () => {
  const pending: PendingRequest[] = [];
  const get = stubCredentialsGet(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { get, pending };
};

const signalOf = (get: { mock: { calls: unknown[][] } }, call = 0) =>
  (get.mock.calls[call][0] as { signal: AbortSignal }).signal;

/** Wraps the field the way the code step does: inside a form that a submit would reach. */
const Harness: React.FC<{ onSubmit: () => void }> = ({ onSubmit }) => {
  const [value, setValue] = React.useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <VerificationCodeInput label="Code" placeholder="Enter code" value={value} onChange={setValue} />
    </form>
  );
};

const codeField = () => screen.getByTestId("sms-code-input") as HTMLInputElement;

beforeEach(() => {
  stubOtpSupport(true);
});

afterEach(() => {
  stubOtpSupport(false);
  if (originalCredentials) {
    Object.defineProperty(navigator, "credentials", originalCredentials);
  } else {
    delete (navigator as { credentials?: unknown }).credentials;
  }
});

describe("VerificationCodeInput WebOTP autofill", () => {
  test("a resolved SMS code fills the field and does not submit the form", async () => {
    const get = stubCredentialsGet(() => Promise.resolve({ code: "123456" }));
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    await waitFor(() => expect(codeField()).toHaveValue("123456"));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toMatchObject({ otp: { transport: ["sms"] } });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a returned code goes through the same digits-only rule as typed input", async () => {
    stubCredentialsGet(() => Promise.resolve({ code: "12 34-56 78" }));
    render(<Harness onSubmit={vi.fn()} />);

    await waitFor(() => expect(codeField()).toHaveValue("123456"));
  });

  test("a code that arrives after the parent has started typing is ignored", async () => {
    const { get, pending } = stubPendingCredentialsGet();
    render(<Harness onSubmit={vi.fn()} />);

    await userEvent.type(codeField(), "5");
    expect(signalOf(get).aborted).toBe(true);

    // Some browsers still settle the request after an abort. The field must not take the value.
    await act(async () => {
      pending[0].resolve({ code: "999999" });
    });
    expect(codeField()).toHaveValue("5");
  });

  test("unmounting aborts the request", () => {
    const { get } = stubPendingCredentialsGet();
    const { unmount } = render(<Harness onSubmit={vi.fn()} />);

    const signal = signalOf(get);
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  test("typing aborts the request", async () => {
    const { get } = stubPendingCredentialsGet();
    render(<Harness onSubmit={vi.fn()} />);

    const signal = signalOf(get);
    expect(signal.aborted).toBe(false);
    await userEvent.type(codeField(), "1");
    expect(signal.aborted).toBe(true);
    expect(codeField()).toHaveValue("1");
  });

  test("without OTPCredential, navigator.credentials.get is never called", () => {
    stubOtpSupport(false);
    const get = stubCredentialsGet(() => Promise.resolve({ code: "123456" }));
    render(<Harness onSubmit={vi.fn()} />);

    expect(get).not.toHaveBeenCalled();
    expect(codeField()).toHaveValue("");
  });

  test.each([
    ["an AbortError", new DOMException("The operation was aborted.", "AbortError")],
    ["a NotAllowedError", new DOMException("User declined.", "NotAllowedError")],
  ])("%s from the request produces no error UI and no log", async (_label, error) => {
    stubCredentialsGet(() => Promise.reject(error));
    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];
    render(<Harness onSubmit={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(codeField()).toHaveValue("");
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
