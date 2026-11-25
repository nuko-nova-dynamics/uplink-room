import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Input } from "@ui-sdk/react/input";
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import type { Question } from "@uplink-room/protocol";
import { api, type Id } from "../lib/api";
import { useAct } from "../lib/session";
import { Icon } from "./Icon";

/** An option's words beside its radio or checkbox: its label, and what it means when that says more. */
function OptionText({ label, description }: { label: string; description?: string | undefined }) {
  return (
    <span>
      {label}
      {description && description !== label ? <span className="muted"> {description}</span> : null}
    </span>
  );
}

/** A T3 Code question's form: an option per question (or several), or your own words where it takes them. */
export function QuestionForm({
  runId,
  promptId,
  questions,
}: {
  runId: Id<"runs">;
  promptId: string;
  questions: Question[];
}) {
  const answerQuestion = useAct(api.inbox.answerQuestion);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const answerFor = (q: Question): string | string[] | undefined => {
    const words = own[q.id]?.trim();
    if (words) return words;
    const chosen = picked[q.id] ?? [];
    if (!chosen.length) return undefined;
    return q.multiSelect ? chosen : chosen[0];
  };
  const ready = questions.every((q) => answerFor(q) !== undefined);
  // One question with one answer to pick: a click on an option sends it, so there's nothing to confirm.
  const oneTap =
    questions.length === 1 && !questions[0]!.multiSelect && questions[0]!.options.length > 0;
  const send = async (answers: Record<string, string | string[]>) => {
    if (sending) return;
    setSending(true);
    try {
      await answerQuestion({ runId, promptId, answers });
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="thread-questions"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void send(Object.fromEntries(questions.map((q) => [q.id, answerFor(q)!])));
      }}
    >
      {questions.map((q) => (
        <fieldset key={q.id} className="thread-question">
          <legend>
            <b>{q.header}</b>
            {q.header !== q.question ? (
              <span className="thread-question-text">{q.question}</span>
            ) : null}
          </legend>
          {oneTap ? (
            q.options.map((o) => (
              <Button
                key={o.label}
                className="thread-option-send"
                disabled={sending}
                onClick={() => send({ [q.id]: o.label })}
              >
                <b>{o.label}</b>
                {o.description && o.description !== o.label ? (
                  <span className="muted">{o.description}</span>
                ) : null}
              </Button>
            ))
          ) : q.multiSelect ? (
            q.options.map((o) => {
              const on = (picked[q.id] ?? []).includes(o.label);
              return (
                <label key={o.label} className="thread-option">
                  <Checkbox
                    checked={on}
                    onCheckedChange={(checked) => {
                      // Picking an option drops your own words: what shows checked is what's sent.
                      setOwn((all) => ({ ...all, [q.id]: "" }));
                      setPicked((all) => ({
                        ...all,
                        [q.id]: checked
                          ? [...(all[q.id] ?? []).filter((l) => l !== o.label), o.label]
                          : (all[q.id] ?? []).filter((l) => l !== o.label),
                      }));
                    }}
                  >
                    <CheckboxIndicator>
                      <Icon name="check" size={12} />
                    </CheckboxIndicator>
                  </Checkbox>
                  <OptionText label={o.label} description={o.description} />
                </label>
              );
            })
          ) : (
            <RadioGroup
              className="thread-option-group"
              aria-label={q.header}
              value={picked[q.id]?.[0] ?? null}
              onValueChange={(label) => {
                if (label === null) return;
                // Picking an option drops your own words: what shows checked is what's sent.
                setOwn((all) => ({ ...all, [q.id]: "" }));
                setPicked((all) => ({ ...all, [q.id]: [label] }));
              }}
            >
              {q.options.map((o) => (
                <label key={o.label} className="thread-option">
                  <Radio value={o.label}>
                    <RadioIndicator />
                  </Radio>
                  <OptionText label={o.label} description={o.description} />
                </label>
              ))}
            </RadioGroup>
          )}
          {q.allowCustomAnswer ? (
            <Input
              className="input"
              placeholder={q.options.length ? "Type your own answer" : "Your answer"}
              aria-label={`${q.header}: your own answer`}
              value={own[q.id] ?? ""}
              onValueChange={(words) => {
                setOwn((all) => ({ ...all, [q.id]: words }));
                // Your own words replace the options picked.
                if (words.trim()) setPicked((all) => ({ ...all, [q.id]: [] }));
              }}
            />
          ) : null}
        </fieldset>
      ))}
      {oneTap && !ready ? null : (
        <div className="row-flex">
          <button className="btn primary" type="submit" disabled={!ready || sending}>
            Send answer
          </button>
          {!ready ? (
            <span className="hint">
              {questions.length === 1
                ? "Pick an answer or write your own."
                : "Answer every question to send."}
            </span>
          ) : null}
        </div>
      )}
    </form>
  );
}
