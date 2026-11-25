/**
 * The Notetaker's quality eval: call scripts with known answers, and the
 * scores for a run against them (transcript word error rate, task precision
 * and recall, owner accuracy, missed decisions, invented tasks).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type Person = { id: string; name: string; voice: string; gain?: number };

export type Turn = {
  speaker: string;
  text: string;
  /** Starts this long before the previous turn ends (talking over it). */
  overlapMs?: number;
  /** Starts this far (0 to 1) into the previous turn, without taking the floor (a backchannel). */
  during?: number;
  /** Silence before this turn; by default a short random gap. */
  gapMs?: number;
  /** Another voice for this turn, such as the same person switching to English. */
  voice?: string;
};

/** Each group is a list of alternatives; every group must match. Alternatives match at the start of a word. */
export type Match = string[][];

/**
 * A task the call produced. `match` and `exclude` are checked against a proposed
 * task's title only: the title is what people read when they accept it.
 * `owner` is a person id, null for no owner, or a list when either is right.
 */
export type TruthTask = { title: string; owner: string | null | (string | null)[]; optional?: boolean; match: Match; exclude?: Match };

export type CallScript = {
  id: string;
  kind: string;
  channel: string;
  language: "en" | "es";
  people: Person[];
  turns: Turn[];
  truth: {
    decisions: { text: string; match: Match; optional?: boolean }[];
    tasks: TruthTask[];
    notTasks: { text: string; match: Match }[];
    notes?: string;
  };
};

export type ProposedTaskOut = { title: string; description?: string; owner: string | null };

export type RunOutput = {
  transcript: { speaker: string; text: string; at: number }[];
  notes: string;
  tasks: ProposedTaskOut[];
  /** The summarizer's own answer, before owners were matched to people: tells an owner it left out from one that matched nobody. */
  summarizerTasks?: { title: string; owner?: string }[];
};

export async function loadCalls(dir: string, only?: string[]): Promise<CallScript[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const calls = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as CallScript));
  return only?.length ? calls.filter((c) => only.some((o) => c.id.startsWith(o))) : calls;
}

// ---------- matching ----------

/** Lowercase ASCII words: accents removed, punctuation gone except dots inside numbers (1.4.1). */
export function normalizeForMatch(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

export function matches(text: string, match: Match): boolean {
  const normalized = normalizeForMatch(text);
  return match.every((group) => group.some((alt) => normalized.includes(` ${normalizeForMatch(alt).trim()}`)));
}

function taskText(task: ProposedTaskOut): string {
  return task.title;
}

/** Pairs proposals with true tasks, one to one, maximizing pairs (Kuhn's augmenting paths). */
/** Whether a proposal can stand for a known task: its title matches the task and none of the task's exclusions. */
function canPair(proposal: ProposedTaskOut, task: TruthTask): boolean {
  const text = taskText(proposal);
  return matches(text, task.match) && !(task.exclude?.some((g) => matches(text, [g])) ?? false);
}

function pairTasks(proposed: ProposedTaskOut[], truth: TruthTask[]): (number | undefined)[] {
  const edges = proposed.map((p) => truth.flatMap((t, ti) => (canPair(p, t) ? [ti] : [])));
  const ownerOf: (number | undefined)[] = truth.map(() => undefined);
  const tryAssign = (pi: number, seen: Set<number>): boolean => {
    for (const ti of edges[pi]!) {
      if (seen.has(ti)) continue;
      seen.add(ti);
      if (ownerOf[ti] === undefined || tryAssign(ownerOf[ti]!, seen)) {
        ownerOf[ti] = pi;
        return true;
      }
    }
    return false;
  };
  for (let pi = 0; pi < proposed.length; pi++) tryAssign(pi, new Set());
  const pairOf: (number | undefined)[] = proposed.map(() => undefined);
  ownerOf.forEach((pi, ti) => {
    if (pi !== undefined) pairOf[pi] = ti;
  });
  return pairOf;
}

// ---------- word error rate ----------

const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ES_ONES = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"];
const ES_TENS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const ES_HUNDREDS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

/** A whole number as words (0 to 999,999), so "48" and "forty eight" count as the same words. */
export function numberWords(n: number, language: "en" | "es"): string {
  if (language === "es") {
    if (n < 30) return ES_ONES[n]!;
    if (n < 100) return `${ES_TENS[Math.floor(n / 10)]}${n % 10 ? ` y ${ES_ONES[n % 10]}` : ""}`;
    if (n === 100) return "cien";
    if (n < 1000) return `${ES_HUNDREDS[Math.floor(n / 100)]}${n % 100 ? ` ${numberWords(n % 100, "es")}` : ""}`;
    const thousands = Math.floor(n / 1000);
    return `${thousands === 1 ? "mil" : `${numberWords(thousands, "es")} mil`}${n % 1000 ? ` ${numberWords(n % 1000, "es")}` : ""}`;
  }
  if (n < 20) return EN_ONES[n]!;
  if (n < 100) return `${EN_TENS[Math.floor(n / 10)]}${n % 10 ? ` ${EN_ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${EN_ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100, "en")}` : ""}`;
  return `${numberWords(Math.floor(n / 1000), "en")} thousand${n % 1000 ? ` ${numberWords(n % 1000, "en")}` : ""}`;
}

/** Words for scoring a transcript: case, accents, punctuation and number formatting don't count. */
export function wordsOf(text: string, language: "en" | "es"): string[] {
  const point = language === "es" ? "punto" : "point";
  const percent = language === "es" ? "por ciento" : "percent";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/%/g, ` ${percent}`)
    .replace(/(\d)\.(?=\d)/g, `$1 ${point} `)
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\b\d{1,6}\b/g, (d) => ` ${numberWords(Number(d), language)} `)
    .replace(/\bokay\b/g, "ok")
    .replace(/\b(mm hmm|mmhmm|mhm|mm hm|uh huh)\b/g, "mhm")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** Word-level edit distance (substitutions, insertions, deletions). */
export function editDistance(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[hyp.length]!;
}

// ---------- scoring ----------

export type CallScore = {
  callId: string;
  sample: number;
  wer: { edits: number; words: number };
  werBySpeaker: Record<string, { edits: number; words: number }>;
  /** Mentions of the team's first names in what was said, and how many the transcript got right (per speaker). */
  names: { said: number; heard: number; missed: string[] };
  tasks: {
    proposed: number;
    matched: number;
    duplicates: number;
    invented: string[];
    traps: string[];
    required: number;
    requiredFound: number;
    missed: string[];
    ownerRight: number;
    ownerChecked: number;
    wrongOwners: string[];
  };
  decisions: { required: number; missed: string[] };
  notesWords: number;
};

/** `team`: the first names of everyone on the team, for the names score. */
export function scoreRun(call: CallScript, out: RunOutput, sample = 1, team: string[] = call.people.map((p) => p.name)): CallScore {
  const nameOf = new Map(call.people.map((p) => [p.id, p.name]));
  const firstNames = [...new Set(team.map((n) => wordsOf(n.split(" ")[0]!, call.language)[0]!))];
  // Transcript: each speaker's words against what they were scripted to say.
  const werBySpeaker: CallScore["werBySpeaker"] = {};
  const names: CallScore["names"] = { said: 0, heard: 0, missed: [] };
  for (const person of call.people) {
    const ref = wordsOf(
      call.turns
        .filter((t) => t.speaker === person.id)
        .map((t) => t.text)
        .join(" "),
      call.language,
    );
    const hyp = wordsOf(
      out.transcript
        .filter((l) => l.speaker === person.name)
        .sort((a, b) => a.at - b.at)
        .map((l) => l.text)
        .join(" "),
      call.language,
    );
    werBySpeaker[person.name] = { edits: editDistance(ref, hyp), words: ref.length };
    for (const name of firstNames) {
      const said = ref.filter((w) => w === name).length;
      const heard = Math.min(said, hyp.filter((w) => w === name).length);
      names.said += said;
      names.heard += heard;
      if (heard < said) names.missed.push(`${person.name} said ${name} ${said}×, heard ${heard}×`);
    }
  }
  const wer = Object.values(werBySpeaker).reduce((s, w) => ({ edits: s.edits + w.edits, words: s.words + w.words }), { edits: 0, words: 0 });

  // Tasks.
  const truth = call.truth.tasks;
  const pairOf = pairTasks(out.tasks, truth);
  const invented: string[] = [];
  const traps: string[] = [];
  let duplicates = 0;
  out.tasks.forEach((task, pi) => {
    if (pairOf[pi] !== undefined) return;
    const text = taskText(task);
    // A duplicate could have stood for a known task another proposal already took; one its exclusions rule out is invented.
    if (truth.some((t) => canPair(task, t))) duplicates++;
    else {
      invented.push(task.title);
      if (call.truth.notTasks.some((n) => matches(text, n.match))) traps.push(task.title);
    }
  });
  const pairedTruth = new Map<number, number>();
  pairOf.forEach((ti, pi) => ti !== undefined && pairedTruth.set(ti, pi));
  const required = truth.filter((t) => !t.optional);
  const missed = truth.flatMap((t, ti) => (!t.optional && !pairedTruth.has(ti) ? [t.title] : []));
  let ownerRight = 0;
  const wrongOwners: string[] = [];
  for (const [ti, pi] of pairedTruth) {
    const owner = truth[ti]!.owner;
    const wanted = (Array.isArray(owner) ? owner : [owner]).map((id) => (id === null ? null : nameOf.get(id)!));
    const got = out.tasks[pi]!.owner;
    if (wanted.includes(got)) ownerRight++;
    else wrongOwners.push(`${truth[ti]!.title}: expected ${wanted.map((w) => w ?? "no owner").join(" or ")}, got ${got ?? "no owner"}`);
  }

  // Decisions: each required one must be in the notes, or in a task, which is shown right under them.
  const posted = [out.notes, ...out.tasks.map((t) => `${t.title} ${t.description ?? ""}`)].join("\n");
  const requiredDecisions = call.truth.decisions.filter((d) => !d.optional);
  const missedDecisions = requiredDecisions.filter((d) => !matches(posted, d.match)).map((d) => d.text);

  return {
    callId: call.id,
    sample,
    wer,
    werBySpeaker,
    names,
    tasks: {
      proposed: out.tasks.length,
      matched: pairedTruth.size,
      duplicates,
      invented,
      traps,
      required: required.length,
      requiredFound: required.length - missed.length,
      missed,
      ownerRight,
      ownerChecked: pairedTruth.size,
      wrongOwners,
    },
    decisions: { required: requiredDecisions.length, missed: missedDecisions },
    notesWords: out.notes.split(/\s+/).filter(Boolean).length,
  };
}

export type Totals = {
  runs: number;
  wer: number;
  /** Share of spoken name mentions the transcript got right. */
  namesRight: number;
  taskPrecision: number;
  taskRecall: number;
  ownerAccuracy: number;
  decisionsMissed: number;
  decisionsRequired: number;
  invented: number;
  duplicates: number;
  notesWords: number;
};

/** a / b, or `empty` when there is nothing to count (no tasks proposed is perfect precision; no words is no error). */
const ratio = (a: number, b: number, empty = 1) => (b === 0 ? empty : a / b);

/** Sums over every call and sample (micro-averaged rates; counts per run on average). */
export function totals(scores: CallScore[]): Totals {
  const sum = (f: (s: CallScore) => number) => scores.reduce((n, s) => n + f(s), 0);
  const runs = scores.length;
  return {
    runs,
    wer: ratio(
      sum((s) => s.wer.edits),
      sum((s) => s.wer.words),
      0,
    ),
    namesRight: ratio(
      sum((s) => s.names?.heard ?? 0),
      sum((s) => s.names?.said ?? 0),
    ),
    taskPrecision: ratio(
      sum((s) => s.tasks.matched),
      sum((s) => s.tasks.proposed),
    ),
    taskRecall: ratio(
      sum((s) => s.tasks.requiredFound),
      sum((s) => s.tasks.required),
    ),
    ownerAccuracy: ratio(
      sum((s) => s.tasks.ownerRight),
      sum((s) => s.tasks.ownerChecked),
    ),
    decisionsMissed: sum((s) => s.decisions.missed.length),
    decisionsRequired: sum((s) => s.decisions.required),
    invented: sum((s) => s.tasks.invented.length),
    duplicates: sum((s) => s.tasks.duplicates),
    notesWords: Math.round(sum((s) => s.notesWords) / Math.max(1, runs)),
  };
}
