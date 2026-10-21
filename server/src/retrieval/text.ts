import { stemmer } from "stemmer";

// Turning text into search terms. Cards and queries go through the same steps, so they meet in the middle:
// lowercase → split → expand shorthand → drop filler → Porter stem. "Rescheduled appointments" and
// "reschedule appointment" both become [reschedul, appoint].

const STOP = new Set(
  (
    "a an the and or but if then so of to for in on at by with from into onto about as is are was were be been " +
    "being am do does did doing have has had i me my mine we us our ours you your yours he him his she her hers " +
    "it its they them their theirs this that these those there here what which who whom whose when where why how " +
    "can could would should will shall may might must please pls just also too very really actually want need " +
    "like let lets make sure some any every each all both again ok okay hey hi thanks thank up out over"
  ).split(" "),
);

/** Shorthand and spelling variants, applied before stemming. One-way: query and card both get expanded. */
const EXPAND: Record<string, string[]> = {
  sms: ["text", "sms"],
  txt: ["text", "sms"],
  texts: ["text", "sms"],
  text: ["text", "sms"],
  texted: ["text", "sms"],
  texting: ["text", "sms"],
  mail: ["email"],
  "e-mail": ["email"],
  emails: ["email"],
  emailed: ["email"],
  appt: ["appointment"],
  appts: ["appointment"],
  mtg: ["meeting"],
  opp: ["opportunity"],
  opps: ["opportunity"],
  todo: ["task"],
  "to-do": ["task"],
  todos: ["task"],
  "to-dos": ["task"],
  info: ["details"],
  convo: ["conversation"],
  convos: ["conversation"],
};

export function terms(text: string): string[] {
  const out: string[] = [];
  const words = text.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  for (const w of words) {
    if (/\d/.test(w) && !/[a-z]{3}/.test(w)) continue; // numbers, amounts, times: no signal for which action
    const expanded = EXPAND[w] ?? (w.includes("-") ? [w.replace(/-/g, ""), ...w.split("-")] : [w]);
    for (const e of expanded) {
      if (e.length < 2 || STOP.has(e)) continue;
      out.push(stemmer(e));
    }
  }
  return out;
}

/** Splits a multi-part request into clauses: "find X, assign them to Y and create Z" → 3 clauses. */
export function clauses(message: string): string[] {
  return message
    .split(/[.;:!?]+|,|\s+(?:and then|then|and|but|also|plus)\s+/i)
    .map((c) => c.trim())
    .filter((c) => terms(c).length > 0);
}
