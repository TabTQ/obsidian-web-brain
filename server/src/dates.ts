// Minimal moment.js-compatible date formatting/parsing for templates and daily notes.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TOKEN_RE = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|A|a|ww|w|X|x|Z/g;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(TOKEN_RE, (tok, lit) => {
    if (lit !== undefined) return lit;
    const h = d.getHours();
    switch (tok) {
      case "YYYY": return String(d.getFullYear());
      case "YY": return pad(d.getFullYear() % 100);
      case "MMMM": return MONTHS[d.getMonth()];
      case "MMM": return MONTHS[d.getMonth()].slice(0, 3);
      case "MM": return pad(d.getMonth() + 1);
      case "M": return String(d.getMonth() + 1);
      case "Do": return ordinal(d.getDate());
      case "DD": return pad(d.getDate());
      case "D": return String(d.getDate());
      case "dddd": return DAYS[d.getDay()];
      case "ddd": return DAYS[d.getDay()].slice(0, 3);
      case "dd": return DAYS[d.getDay()].slice(0, 2);
      case "d": return String(d.getDay());
      case "HH": return pad(h);
      case "H": return String(h);
      case "hh": return pad(h % 12 || 12);
      case "h": return String(h % 12 || 12);
      case "mm": return pad(d.getMinutes());
      case "m": return String(d.getMinutes());
      case "ss": return pad(d.getSeconds());
      case "s": return String(d.getSeconds());
      case "A": return h < 12 ? "AM" : "PM";
      case "a": return h < 12 ? "am" : "pm";
      case "ww": return pad(isoWeek(d));
      case "w": return String(isoWeek(d));
      case "X": return String(Math.floor(d.getTime() / 1000));
      case "x": return String(d.getTime());
      case "Z": {
        const o = -d.getTimezoneOffset();
        return (o >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(o) / 60)) + ":" + pad(Math.abs(o) % 60);
      }
    }
    return tok;
  });
}

/** Parse a string produced by formatDate(fmt). Returns null if it does not match. */
export function parseDate(s: string, fmt: string): Date | null {
  let re = "^";
  const order: string[] = [];
  let last = 0;
  fmt.replace(TOKEN_RE, (tok, lit, offset: number) => {
    re += escapeRe(fmt.slice(last, offset));
    last = offset + tok.length;
    if (lit !== undefined) {
      re += escapeRe(lit);
      return tok;
    }
    const map: Record<string, string> = {
      YYYY: "(\\d{4})", YY: "(\\d{2})", MM: "(\\d{2})", M: "(\\d{1,2})", DD: "(\\d{2})", D: "(\\d{1,2})",
      Do: "(\\d{1,2})(?:st|nd|rd|th)", HH: "(\\d{2})", H: "(\\d{1,2})", mm: "(\\d{2})", m: "(\\d{1,2})",
      ss: "(\\d{2})", s: "(\\d{1,2})", MMMM: "([A-Za-z]+)", MMM: "([A-Za-z]{3})", dddd: "[A-Za-z]+", ddd: "[A-Za-z]{3}", dd: "[A-Za-z]{2}",
    };
    const part = map[tok] ?? ".+?";
    re += part;
    if (part.startsWith("(")) order.push(tok);
    return tok;
  });
  re += escapeRe(fmt.slice(last)) + "$";
  const m = s.match(new RegExp(re));
  if (!m) return null;
  let y = 1970, mo = 0, day = 1, h = 0, mi = 0, se = 0;
  order.forEach((tok, i) => {
    const v = m[i + 1];
    switch (tok) {
      case "YYYY": y = +v; break;
      case "YY": y = 2000 + +v; break;
      case "MM": case "M": mo = +v - 1; break;
      case "MMMM": case "MMM": mo = MONTHS.findIndex((x) => x.toLowerCase().startsWith(v.toLowerCase().slice(0, 3))); break;
      case "DD": case "D": case "Do": day = +v; break;
      case "HH": case "H": h = +v; break;
      case "mm": case "m": mi = +v; break;
      case "ss": case "s": se = +v; break;
    }
  });
  const d = new Date(y, mo, day, h, mi, se);
  return isNaN(d.getTime()) ? null : d;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apply template variables: {{title}}, {{date}}, {{time}}, {{date:FMT}}, {{time:FMT}} (case-insensitive). */
export function applyTemplate(text: string, vars: { title: string; now?: Date; dateFormat?: string; timeFormat?: string }): string {
  const now = vars.now ?? new Date();
  return text.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_m, name: string, fmt?: string) => {
    const n = name.toLowerCase();
    if (n === "title") return vars.title;
    const f = fmt?.trim() || (n === "date" ? vars.dateFormat || "YYYY-MM-DD" : vars.timeFormat || "HH:mm");
    return formatDate(now, f);
  });
}
