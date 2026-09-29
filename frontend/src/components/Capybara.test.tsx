import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { Capybara } from "./Capybara";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reacts to a click and respects reduced motion", () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  const { unmount } = render(<MemoryRouter><Capybara /></MemoryRouter>);
  const button = screen.getByRole("button", { name: "Give Mochi a surprise" });
  fireEvent.click(button);
  expect(button.className).toContain("cap-boop");

  unmount();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
  render(<MemoryRouter><Capybara /></MemoryRouter>);
  const quiet = screen.getByRole("button", { name: "Give Mochi a surprise" });
  fireEvent.click(quiet);
  expect(quiet.className).not.toContain("cap-boop");
});
