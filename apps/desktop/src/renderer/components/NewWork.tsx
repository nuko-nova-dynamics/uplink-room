import { useRef, useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { api, type Id } from "../lib/api";
import { useAct, useRoomQuery } from "../lib/session";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { RepoPicker } from "./RepoPicker";

/** The Project select's "No project": a Select item needs a value, and a task without one has none. */
export const NO_PROJECT = "none";

/** A select's list of choices (UI SDK Select), each with the app's check on the chosen one. */
export function ChoiceList({ choices }: { choices: { value: string; label: string }[] }) {
  return (
    <SelectContent className="pop">
      {choices.map((choice) => (
        <SelectItem key={choice.value} value={choice.value}>
          <span className="grow truncate">{choice.label}</span>
          <SelectItemIndicator>
            <Icon name="check" />
          </SelectItemIndicator>
        </SelectItem>
      ))}
    </SelectContent>
  );
}

/**
 * New project (spec story 9): a name, and the repos its work touches. It gets its own channel.
 * Picking a synced repo before naming the project names it after the repo (ADR 0020).
 */
export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (projectId: Id<"projects">) => void;
}) {
  const create = useAct(api.projects.create);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const createButton = useRef<HTMLButtonElement>(null);
  const submit = async () => {
    if (!name.trim()) return;
    const projectId = await create({ name, repos });
    if (projectId) onCreated(projectId as Id<"projects">);
  };
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          {/* Pending while the room creates it, so a second press can't make two. */}
          <Button
            ref={createButton}
            className="btn primary"
            disabled={!name.trim()}
            onClick={submit}
          >
            Create project
          </Button>
        </>
      }
    >
      <Field className="field">
        <FieldLabel className="label">Name</FieldLabel>
        <Input
          id="project-name"
          data-dialog-initial-focus
          className="input"
          value={name}
          onValueChange={(value) => {
            setName(value);
            setNamed(value.trim() !== "");
          }}
          // Enter presses Create project, so it's pending the same way.
          onKeyDown={(event) => event.key === "Enter" && createButton.current?.click()}
        />
        <FieldDescription className="hint">
          The project gets its own channel and a board of tasks. Pick a repo first and it takes the
          repo's name.
        </FieldDescription>
      </Field>
      <Field className="field">
        <FieldLabel className="label">Repos (optional)</FieldLabel>
        <RepoPicker
          inputId="project-repos"
          repos={repos}
          onChange={setRepos}
          onPickSynced={(repo) => {
            if (!named) setName(repo.fullName.split("/")[1] ?? repo.fullName);
          }}
        />
        <FieldDescription className="hint">
          New runs offer these repos, and unfiled runs in them are suggested for this project.
        </FieldDescription>
      </Field>
    </Dialog>
  );
}

/**
 * New task (spec story 14): a title, and optionally a description. From a project's board
 * (`chooseProject` unset) it goes to that project. Elsewhere, such as the Inbox, the person
 * picks a project or none.
 */
export function NewTaskDialog({
  projectId,
  chooseProject = false,
  initialTitle = "",
  onClose,
  onCreated,
}: {
  projectId?: Id<"projects"> | undefined;
  /** What was typed where the task was started (the Inbox's message box), as its title. */
  initialTitle?: string;
  chooseProject?: boolean;
  onClose: () => void;
  onCreated: (taskId: Id<"tasks">) => void;
}) {
  const create = useAct(api.tasks.create);
  const projects = useRoomQuery(api.projects.list, {});
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [project, setProject] = useState<string>(projectId ?? "");
  const choices = [
    { value: NO_PROJECT, label: "No project" },
    ...(projects ?? []).map((p) => ({ value: p.projectId as string, label: p.name })),
  ];
  const submit = async () => {
    const taskId = await create({
      title,
      ...(project ? { projectId: project as Id<"projects"> } : {}),
      ...(description.trim() ? { description } : {}),
    });
    if (taskId) onCreated(taskId as Id<"tasks">);
  };
  return (
    <Dialog
      title="New task"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <Button className="btn primary" disabled={!title.trim()} onClick={submit}>
            Create task
          </Button>
        </>
      }
    >
      <Field className="field">
        <FieldLabel className="label">Title</FieldLabel>
        <Input
          id="task-title"
          data-dialog-initial-focus
          className="input"
          value={title}
          onValueChange={setTitle}
        />
      </Field>
      {chooseProject ? (
        <Field className="field">
          <FieldLabel className="label">Project</FieldLabel>
          <Select
            items={choices}
            value={project || NO_PROJECT}
            onValueChange={(value) => setProject(value === NO_PROJECT ? "" : String(value))}
          >
            <SelectTrigger id="task-project" className="select">
              <SelectValue />
            </SelectTrigger>
            <ChoiceList choices={choices} />
          </Select>
        </Field>
      ) : null}
      <Field className="field">
        <FieldLabel className="label">Description</FieldLabel>
        <Textarea
          id="task-desc"
          className="textarea"
          value={description}
          onValueChange={setDescription}
        />
        <FieldDescription className="hint">
          You own the task. It can have no runs yet: pick an agent when you're ready.
        </FieldDescription>
      </Field>
    </Dialog>
  );
}
