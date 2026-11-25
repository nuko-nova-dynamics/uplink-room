// @vitest-environment happy-dom
/** A T3 Code question answered from the room (ADR 0023): what shows chosen is what's sent. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ answer: vi.fn(async (_args: unknown) => null) }));
vi.mock("../lib/session", () => ({ useAct: () => mocks.answer }));

import { QuestionForm } from "../components/QuestionForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const question = {
  id: "rounding",
  header: "Rounding",
  question: "Which rounding should totals use?",
  options: [
    { label: "Half up", description: "0.5 goes up" },
    { label: "Banker's", description: "0.5 goes to even" },
  ],
  multiSelect: false,
  allowCustomAnswer: true,
};

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const second = {
  id: "currency",
  header: "Currency",
  question: "Which currency do totals show?",
  options: [
    { label: "USD", description: "Dollars" },
    { label: "EUR", description: "Euros" },
  ],
  multiSelect: false,
  allowCustomAnswer: false,
};

test("an option picked after your own words is the answer sent, and words typed after an option replace it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  // Two questions: options are picked, then sent together with Send answer.
  act(() => root.render(<QuestionForm runId={"run-1" as never} promptId="p1" questions={[question, second]} />));
  const own = host.querySelector<HTMLInputElement>("input.input")!;
  const [halfUp, , usd] = host.querySelectorAll<HTMLButtonElement>("button[role=radio]");
  const submit = () => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  act(() => usd!.click());
  act(() => type(own, "Round to the cent, half away from zero"));
  act(() => halfUp!.click());
  expect(own.value).toBe("");
  await submit();
  expect(mocks.answer).toHaveBeenLastCalledWith({ runId: "run-1", promptId: "p1", answers: { rounding: "Half up", currency: "USD" } });

  act(() => type(own, "Round to the cent"));
  expect(halfUp!.getAttribute("aria-checked")).toBe("false");
  await submit();
  expect(mocks.answer).toHaveBeenLastCalledWith({ runId: "run-1", promptId: "p1", answers: { rounding: "Round to the cent", currency: "USD" } });
  act(() => root.unmount());
});

test("one question with one answer sends an option on its click, and your own words with Send answer", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<QuestionForm runId={"run-1" as never} promptId="p1" questions={[question]} />));
  const option = [...host.querySelectorAll<HTMLButtonElement>("button.thread-option-send")].find((b) => b.textContent?.startsWith("Banker's"))!;
  await act(async () => option.click());
  expect(mocks.answer).toHaveBeenLastCalledWith({ runId: "run-1", promptId: "p1", answers: { rounding: "Banker's" } });

  act(() => type(host.querySelector<HTMLInputElement>("input.input")!, "Round to the cent"));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mocks.answer).toHaveBeenLastCalledWith({ runId: "run-1", promptId: "p1", answers: { rounding: "Round to the cent" } });
  act(() => root.unmount());
});
