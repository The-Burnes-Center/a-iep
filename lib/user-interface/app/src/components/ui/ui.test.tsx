/**
 * The app's controls (docs/UI_STANDARDS.md): what each one guarantees to a
 * parent using a screen reader, a keyboard or a thumb.
 */
import React from "react";
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Button from "./Button";
import { Checkbox, TextField } from "./fields";
import { Notice, StatusTag } from "./feedback";

describe("Button", () => {
  test("is a real button that does not submit a form by accident", () => {
    render(<Button>Save changes</Button>);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("ui-button", "ui-button--primary");
  });

  test("navigates as a link that looks the same, never a bare text link", () => {
    render(<MemoryRouter><Button to="/account-center" variant="secondary">Back to Account</Button></MemoryRouter>);
    const link = screen.getByRole("link", { name: "Back to Account" });
    expect(link).toHaveAttribute("href", "/account-center");
    expect(link).toHaveClass("ui-button", "ui-button--secondary");
  });

  test("while busy, says so and cannot be pressed twice", () => {
    const onClick = vi.fn();
    render(<Button busy busyLabel="Saving..." onClick={onClick}>Save changes</Button>);
    const button = screen.getByRole("button", { name: /Saving/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("keeps its icon out of the accessible name", () => {
    render(<Button icon={<svg data-testid="icon" />}>Upload for Maya</Button>);
    expect(screen.getByRole("button", { name: "Upload for Maya" })).toBeInTheDocument();
    expect(screen.getByTestId("icon").parentElement).toHaveAttribute("aria-hidden", "true");
  });
});

describe("TextField", () => {
  test("is named by its visible label", () => {
    render(<TextField label="Your child's full name" />);
    expect(screen.getByRole("textbox", { name: "Your child's full name" })).toBeInTheDocument();
  });

  test("announces its hint and its error, and says it is invalid", () => {
    render(<TextField label="Name" hint="As it is written on the IEP" error="Enter your child's name" />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveAccessibleDescription("As it is written on the IEP Enter your child's name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    // Announced when it appears, not only findable later.
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your child's name");
  });

  test("with no error, is not marked invalid and describes only what is there", () => {
    render(<TextField label="Name" />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  test("marks an optional field in words, not with an asterisk on the rest", () => {
    render(<TextField label="School district" optionalLabel="(optional)" />);
    expect(screen.getByText("(optional)")).toBeInTheDocument();
  });

  test("keeps what the parent typed when an error appears", () => {
    const { rerender } = render(<TextField label="Name" defaultValue="Ma" />);
    rerender(<TextField label="Name" defaultValue="Ma" error="Enter a full name" />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Ma");
  });
});

describe("Checkbox", () => {
  test("the whole label is the target", () => {
    const onChange = vi.fn();
    render(<Checkbox label="I agree" onChange={onChange} />);
    fireEvent.click(screen.getByText("I agree"));
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "I agree" })).toBeInTheDocument();
  });

  test("announces an error", () => {
    render(<Checkbox label="I agree" error="Agree to continue" />);
    expect(screen.getByRole("checkbox", { name: "I agree" })).toHaveAccessibleDescription("Agree to continue");
  });
});

describe("StatusTag and Notice", () => {
  test("a status is in words, not colour alone", () => {
    render(<StatusTag tone="ready">Summary ready</StatusTag>);
    expect(screen.getByText("Summary ready")).toBeInTheDocument();
  });

  test("an error notice is announced; an information notice is not, unless asked", () => {
    const { rerender } = render(<Notice tone="error" title="We couldn't save this">Try again.</Notice>);
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't save this");
    rerender(<Notice tone="info" title="Good to know" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<Notice tone="success" title="Saved" announce />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });
});
